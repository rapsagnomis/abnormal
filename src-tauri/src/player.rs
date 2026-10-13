//! Two-track playback engine.
//!
//! Both tracks run simultaneously, each with its own playhead and loop region; the A/B switch
//! only crossfades their gains. That keeps A and B in sync when they are aligned, while still
//! allowing each track to be positioned (and looped) independently to compare different sections.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;

use anyhow::{Result, anyhow};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};

use crate::decode::AudioData;

pub const SLOTS: usize = 2;
const NONE: u64 = u64::MAX;
/// Length of A/B crossfades and pause/resume fades.
const FADE_SECONDS: f32 = 0.015;
/// Trim changes glide with a one-pole filter; this scales its coefficient relative to the fade step.
const TRIM_SMOOTHING: f32 = 0.5;
const UNITY_BITS: u32 = 0x3f80_0000; // 1.0f32

/// Interleaved stereo at the output device's sample rate.
pub struct PlaybackBuffer {
    samples: Vec<f32>,
    frames: u64,
}

impl PlaybackBuffer {
    /// Convert decoded audio to stereo at `device_rate`. Mono is duplicated to both sides;
    /// for more than two channels only the first two are played.
    pub fn new(audio: &AudioData, device_rate: u32) -> Result<Self> {
        let frames = audio.frames();
        let left = &audio.channels[0];
        let right = audio.channels.get(1).unwrap_or(left);
        let mut stereo = Vec::with_capacity(frames * 2);
        for (&l, &r) in left.iter().zip(right) {
            stereo.push(l);
            stereo.push(r);
        }

        if audio.sample_rate != device_rate {
            let mut resampler = Fft::<f32>::new(
                audio.sample_rate as usize,
                device_rate as usize,
                1024,
                2,
                FixedSync::Both,
            )?;
            let input = InterleavedSlice::new(&stereo[..], 2, frames)?;
            stereo = resampler.process_all(&input, frames, None)?.take_data();
        }

        let frames = (stereo.len() / 2) as u64;
        Ok(Self { samples: stereo, frames })
    }

    #[cfg(test)]
    pub fn frames(&self) -> u64 {
        self.frames
    }

    #[cfg(test)]
    pub fn samples(&self) -> &[f32] {
        &self.samples
    }

    #[cfg(test)]
    pub fn frame(&self, i: usize) -> (f32, f32) {
        (self.samples[i * 2], self.samples[i * 2 + 1])
    }
}

/// State shared between the UI-facing commands and the audio callback.
pub struct Shared {
    pub device_rate: AtomicU32,
    playing: AtomicBool,
    active: AtomicUsize,
    loop_enabled: AtomicBool,
    /// Per-track gain trim (linear, stored as f32 bits), e.g. for loudness matching.
    trims: [AtomicU32; SLOTS],
    /// Written only by the audio callback.
    positions: [AtomicU64; SLOTS],
    /// Pending seek per slot (frame index, `NONE` if none); consumed by the callback.
    seek_requests: [AtomicU64; SLOTS],
    loop_start: [AtomicU64; SLOTS],
    loop_end: [AtomicU64; SLOTS],
    tracks: Mutex<[Option<Arc<PlaybackBuffer>>; SLOTS]>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transport {
    pub playing: bool,
    pub active: usize,
    pub loop_enabled: bool,
    /// Playhead per slot, in seconds.
    pub positions: [f64; SLOTS],
}

impl Shared {
    fn new() -> Self {
        Self {
            device_rate: AtomicU32::new(0),
            playing: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            loop_enabled: AtomicBool::new(false),
            trims: [const { AtomicU32::new(UNITY_BITS) }; SLOTS],
            positions: [const { AtomicU64::new(0) }; SLOTS],
            seek_requests: [const { AtomicU64::new(NONE) }; SLOTS],
            loop_start: [const { AtomicU64::new(NONE) }; SLOTS],
            loop_end: [const { AtomicU64::new(NONE) }; SLOTS],
            tracks: Mutex::new([None, None]),
        }
    }

    fn rate(&self) -> f64 {
        self.device_rate.load(Ordering::Relaxed).max(1) as f64
    }

    fn to_frames(&self, seconds: f64) -> u64 {
        (seconds.max(0.0) * self.rate()).round() as u64
    }

    pub fn set_track(&self, slot: usize, buffer: Option<PlaybackBuffer>) {
        let old = {
            let mut tracks = self.tracks.lock().unwrap();
            self.loop_start[slot].store(NONE, Ordering::Relaxed);
            self.loop_end[slot].store(NONE, Ordering::Relaxed);
            self.seek_requests[slot].store(0, Ordering::Relaxed);
            std::mem::replace(&mut tracks[slot], buffer.map(Arc::new))
        };
        // Old buffer is dropped here, outside the lock and off the audio thread.
        drop(old);
    }

    pub fn set_playing(&self, playing: bool) {
        self.playing.store(playing, Ordering::Relaxed);
    }

    pub fn set_active(&self, slot: usize) {
        self.active.store(slot, Ordering::Relaxed);
    }

    pub fn seek(&self, slot: usize, seconds: f64) {
        self.seek_requests[slot].store(self.to_frames(seconds), Ordering::Relaxed);
    }

    pub fn set_loop(&self, slot: usize, region: Option<(f64, f64)>) {
        let (start, end) = match region {
            Some((s, e)) if e > s => (self.to_frames(s), self.to_frames(e)),
            _ => (NONE, NONE),
        };
        // Clear the end first so the callback never sees a new start with a stale end.
        self.loop_end[slot].store(NONE, Ordering::Relaxed);
        self.loop_start[slot].store(start, Ordering::Relaxed);
        self.loop_end[slot].store(end, Ordering::Relaxed);
    }

    pub fn set_trim_db(&self, slot: usize, db: f64) {
        let linear = 10f32.powf(db as f32 / 20.0);
        self.trims[slot].store(linear.to_bits(), Ordering::Relaxed);
    }

    pub fn set_loop_enabled(&self, enabled: bool) {
        self.loop_enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn transport(&self) -> Transport {
        let rate = self.rate();
        Transport {
            playing: self.playing.load(Ordering::Relaxed),
            active: self.active.load(Ordering::Relaxed),
            loop_enabled: self.loop_enabled.load(Ordering::Relaxed),
            positions: std::array::from_fn(|i| {
                self.positions[i].load(Ordering::Relaxed) as f64 / rate
            }),
        }
    }
}

/// Per-stream state owned by the audio callback.
struct Mixer {
    shared: Arc<Shared>,
    out_channels: usize,
    fade_step: f32,
    master: f32,
    gains: [f32; SLOTS],
    /// Smoothed per-track trims.
    trims: [f32; SLOTS],
}

impl Mixer {
    fn render(&mut self, out: &mut [f32]) {
        let shared = &self.shared;
        // Never block the audio thread: if a track is being swapped, output one buffer of silence.
        let Ok(tracks) = shared.tracks.try_lock() else {
            out.fill(0.0);
            return;
        };

        let mut pos: [u64; SLOTS] = std::array::from_fn(|i| {
            match shared.seek_requests[i].swap(NONE, Ordering::Relaxed) {
                NONE => shared.positions[i].load(Ordering::Relaxed),
                p => p,
            }
        });
        let playing = shared.playing.load(Ordering::Relaxed);
        let active = shared.active.load(Ordering::Relaxed);
        let looping = shared.loop_enabled.load(Ordering::Relaxed);
        let trim_targets: [f32; SLOTS] =
            std::array::from_fn(|i| f32::from_bits(shared.trims[i].load(Ordering::Relaxed)));
        let loops: [(u64, u64); SLOTS] = std::array::from_fn(|i| {
            (shared.loop_start[i].load(Ordering::Relaxed), shared.loop_end[i].load(Ordering::Relaxed))
        });

        let master_target = if playing { 1.0 } else { 0.0 };
        // Fully faded out and paused: hold position, output silence.
        if !playing && self.master == 0.0 {
            out.fill(0.0);
        } else {
            for frame in out.chunks_mut(self.out_channels) {
                self.master = approach(self.master, master_target, self.fade_step);
                let (mut l, mut r) = (0.0f32, 0.0f32);
                for i in 0..SLOTS {
                    let target = if i == active { 1.0 } else { 0.0 };
                    self.gains[i] = approach(self.gains[i], target, self.fade_step);
                    self.trims[i] += (trim_targets[i] - self.trims[i]) * TRIM_SMOOTHING * self.fade_step;
                    let Some(track) = &tracks[i] else { continue };
                    if pos[i] < track.frames {
                        let idx = pos[i] as usize * 2;
                        let g = self.gains[i] * self.trims[i] * self.master;
                        l += track.samples[idx] * g;
                        r += track.samples[idx + 1] * g;
                        pos[i] += 1;
                    }
                    let (ls, le) = loops[i];
                    if looping && le != NONE && pos[i] >= le.min(track.frames) {
                        pos[i] = ls;
                    }
                }
                match frame {
                    [mono] => *mono = 0.5 * (l + r),
                    [fl, fr, rest @ ..] => {
                        *fl = l;
                        *fr = r;
                        rest.fill(0.0);
                    }
                    [] => {}
                }
            }
        }

        // Stop once every loaded track has run off its end.
        let all_ended = tracks
            .iter()
            .zip(&pos)
            .all(|(t, &p)| t.as_ref().is_none_or(|t| p >= t.frames));
        if playing && all_ended && tracks.iter().any(Option::is_some) {
            shared.playing.store(false, Ordering::Relaxed);
        }
        for (slot, p) in shared.positions.iter().zip(pos) {
            slot.store(p, Ordering::Relaxed);
        }
    }
}

fn approach(current: f32, target: f32, step: f32) -> f32 {
    if current < target {
        (current + step).min(target)
    } else {
        (current - step).max(target)
    }
}

/// Open the default output device and start the engine on a dedicated thread that owns the
/// stream (cpal streams are not `Send` on every platform).
pub fn start() -> (Arc<Shared>, Result<u32>) {
    let shared = Arc::new(Shared::new());
    let (tx, rx) = mpsc::channel();
    let thread_shared = shared.clone();

    thread::Builder::new()
        .name("audio-output".into())
        .spawn(move || {
            let stream = (|| -> Result<(cpal::Stream, u32)> {
                let device = cpal::default_host()
                    .default_output_device()
                    .ok_or_else(|| anyhow!("no audio output device"))?;
                let config: cpal::StreamConfig = device.default_output_config()?.into();
                let rate = config.sample_rate;
                thread_shared.device_rate.store(rate, Ordering::Relaxed);
                let mut mixer = Mixer {
                    shared: thread_shared.clone(),
                    out_channels: config.channels as usize,
                    fade_step: 1.0 / (FADE_SECONDS * rate as f32),
                    master: 0.0,
                    gains: [1.0, 0.0],
                    trims: [1.0; SLOTS],
                };
                let stream = device.build_output_stream::<f32, _, _>(
                    config,
                    move |data, _| mixer.render(data),
                    |err| eprintln!("audio stream error: {err}"),
                    None,
                )?;
                stream.play()?;
                Ok((stream, rate))
            })();

            match stream {
                Ok((stream, rate)) => {
                    let _ = tx.send(Ok(rate));
                    // Keep the stream alive for the lifetime of the app.
                    loop {
                        thread::park();
                        let _ = &stream;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e));
                }
            }
        })
        .expect("failed to spawn audio thread");

    let result = rx.recv().unwrap_or_else(|_| Err(anyhow!("audio thread exited")));
    (shared, result)
}
