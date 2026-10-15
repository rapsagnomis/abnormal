//! Two-track playback engine.
//!
//! Both tracks run simultaneously, each with its own playhead and loop region; the A/B switch
//! only crossfades their gains. That keeps A and B in sync when they are aligned, while still
//! allowing each track to be positioned (and looped) independently to compare different sections.
//!
//! A track can also carry an alternate rendering (the full EQ match), sample-aligned with it;
//! switching to it is another crossfade.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;

use anyhow::{Result, anyhow};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};

use crate::decode::AudioData;
use crate::eq::{Biquad, Filter, Placement};
use crate::fir;

/// A and B, then up to six extra tracks to switch between (C–H).
pub const SLOTS: usize = 8;
const NONE: u64 = u64::MAX;
/// Length of A/B crossfades and pause/resume fades.
const FADE_SECONDS: f32 = 0.015;
/// Trim changes glide with a one-pole filter; this scales its coefficient relative to the fade step.
const TRIM_SMOOTHING: f32 = 0.5;
const UNITY_BITS: u32 = 0x3f80_0000; // 1.0f32
/// Most EQ moves a track can be auditioned with (6 stereo moves, a width change, 3 side moves).
pub const MAX_EQ_STAGES: usize = 12;

/// Playback EQ for one track. Filters run even while disabled so switching it on is a crossfade
/// between warm signals, not a transient.
#[derive(Clone, Copy, Default)]
struct EqSettings {
    stages: [Biquad; MAX_EQ_STAGES],
    /// Per stage: filter only the side (L − R), not both channels.
    side: [bool; MAX_EQ_STAGES],
    count: usize,
    enabled: bool,
}

/// Filter state (see `Biquad::process`), per stage and channel (a side stage uses the first).
type EqState = [[[f64; 2]; 2]; MAX_EQ_STAGES];

fn run_eq(settings: &EqSettings, state: &mut EqState, l: f32, r: f32) -> (f32, f32) {
    let mut x = [l as f64, r as f64];
    for ((q, st), &side) in settings.stages[..settings.count].iter().zip(state.iter_mut()).zip(&settings.side) {
        if side {
            let (m, s) = ((x[0] + x[1]) * 0.5, (x[0] - x[1]) * 0.5);
            let s = q.process(&mut st[0], s);
            x = [m + s, m - s];
        } else {
            for (v, z) in x.iter_mut().zip(st.iter_mut()) {
                *v = q.process(z, *v);
            }
        }
    }
    (x[0] as f32, x[1] as f32)
}

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

/// What is loaded in a slot: the track, and optionally an alternate rendering of it.
#[derive(Default)]
struct Loaded {
    track: Option<Arc<PlaybackBuffer>>,
    alt: Option<Arc<PlaybackBuffer>>,
}

/// State shared between the UI-facing commands and the audio callback.
pub struct Shared {
    pub device_rate: AtomicU32,
    playing: AtomicBool,
    active: AtomicUsize,
    /// Per track: loop its selection.
    loop_enabled: [AtomicBool; SLOTS],
    /// Per-track gain trim (linear, stored as f32 bits), e.g. for loudness matching.
    trims: [AtomicU32; SLOTS],
    /// App-wide output volume (linear, 0–1, stored as f32 bits), applied after the trims.
    volume: AtomicU32,
    /// Written only by the audio callback.
    positions: [AtomicU64; SLOTS],
    /// Pending seek per slot (frame index, `NONE` if none); consumed by the callback.
    seek_requests: [AtomicU64; SLOTS],
    loop_start: [AtomicU64; SLOTS],
    loop_end: [AtomicU64; SLOTS],
    tracks: Mutex<[Loaded; SLOTS]>,
    /// Play the alternate rendering instead of the track, per slot.
    alt_enabled: [AtomicBool; SLOTS],
    /// Bumped by each alternate render, so a slower earlier one can't replace a newer one.
    alt_generation: [AtomicU64; SLOTS],
    /// Peak level of each track over the last callback (linear, f32 bits), after its trim and EQ
    /// but before the A/B switch and volume: what it would play at if switched to. 0 when paused.
    meters: [AtomicU32; SLOTS],
    /// Playback EQ per slot; the callback copies it when `eq_version` changes.
    eq: Mutex<[EqSettings; SLOTS]>,
    eq_version: AtomicU64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transport {
    pub playing: bool,
    pub active: usize,
    /// Per track: looping its selection.
    pub loop_enabled: [bool; SLOTS],
    /// Playhead per slot, in seconds.
    pub positions: [f64; SLOTS],
    /// Peak level per track over the last audio buffer, linear (see `Shared::meters`).
    pub levels: [f32; SLOTS],
}

impl Shared {
    fn new() -> Self {
        Self {
            device_rate: AtomicU32::new(0),
            playing: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            loop_enabled: [const { AtomicBool::new(false) }; SLOTS],
            trims: [const { AtomicU32::new(UNITY_BITS) }; SLOTS],
            volume: AtomicU32::new(UNITY_BITS),
            positions: [const { AtomicU64::new(0) }; SLOTS],
            seek_requests: [const { AtomicU64::new(NONE) }; SLOTS],
            loop_start: [const { AtomicU64::new(NONE) }; SLOTS],
            loop_end: [const { AtomicU64::new(NONE) }; SLOTS],
            tracks: Mutex::new(Default::default()),
            alt_enabled: [const { AtomicBool::new(false) }; SLOTS],
            alt_generation: [const { AtomicU64::new(0) }; SLOTS],
            meters: [const { AtomicU32::new(0) }; SLOTS],
            eq: Mutex::new([EqSettings::default(); SLOTS]),
            eq_version: AtomicU64::new(0),
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
            self.alt_generation[slot].fetch_add(1, Ordering::Relaxed);
            std::mem::replace(&mut tracks[slot], Loaded { track: buffer.map(Arc::new), alt: None })
        };
        // Old buffers are dropped here, outside the lock and off the audio thread.
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

    /// Output volume for everything, linear; clamped to 0–1 so it only ever attenuates.
    pub fn set_volume(&self, gain: f64) {
        let gain = if gain.is_finite() { gain.clamp(0.0, 1.0) } else { 1.0 };
        self.volume.store((gain as f32).to_bits(), Ordering::Relaxed);
    }

    /// Filters to audition on a track; `enabled = false` keeps them loaded but bypassed.
    pub fn set_eq(&self, slot: usize, filters: &[Filter], enabled: bool) {
        let rate = self.rate();
        let mut settings = EqSettings { enabled, ..Default::default() };
        for ((stage, side), f) in settings.stages.iter_mut().zip(settings.side.iter_mut()).zip(filters) {
            *stage = f.biquad(rate);
            *side = f.placement == Placement::Side;
            settings.count += 1;
        }
        self.eq.lock().unwrap()[slot] = settings;
        self.eq_version.fetch_add(1, Ordering::Release);
    }

    /// Render the slot's track through linear-phase mid and side correction curves (dB on the
    /// log-spaced `freqs`) as its alternate, or drop the alternate (`None`). Slow (a second or
    /// so for a song); returns false if the track or a newer render replaced it meanwhile.
    pub fn render_alt(&self, slot: usize, curves: Option<(&[f64], &[f32], &[f32])>) -> bool {
        let generation = self.alt_generation[slot].fetch_add(1, Ordering::Relaxed) + 1;
        let Some((freqs, mid, side)) = curves else {
            let old = self.tracks.lock().unwrap()[slot].alt.take();
            drop(old);
            return true;
        };
        let Some(track) = self.tracks.lock().unwrap()[slot].track.clone() else { return false };
        let rate = self.rate();
        let taps = fir::taps_for(rate);
        let samples = fir::filter_mid_side(
            &track.samples,
            &fir::design(freqs, mid, rate, taps),
            &fir::design(freqs, side, rate, taps),
        );
        let alt = Arc::new(PlaybackBuffer { samples, frames: track.frames });
        let old = {
            let mut tracks = self.tracks.lock().unwrap();
            let current = tracks[slot].track.as_ref().is_some_and(|t| Arc::ptr_eq(t, &track));
            if !current || self.alt_generation[slot].load(Ordering::Relaxed) != generation {
                return false;
            }
            tracks[slot].alt.replace(alt)
        };
        drop(old);
        true
    }

    /// Play the alternate rendering (when there is one) instead of the track.
    pub fn set_alt_enabled(&self, slot: usize, enabled: bool) {
        self.alt_enabled[slot].store(enabled, Ordering::Relaxed);
    }

    pub fn set_loop_enabled(&self, slot: usize, enabled: bool) {
        self.loop_enabled[slot].store(enabled, Ordering::Relaxed);
    }

    pub fn transport(&self) -> Transport {
        let rate = self.rate();
        Transport {
            playing: self.playing.load(Ordering::Relaxed),
            active: self.active.load(Ordering::Relaxed),
            loop_enabled: std::array::from_fn(|i| self.loop_enabled[i].load(Ordering::Relaxed)),
            positions: std::array::from_fn(|i| {
                self.positions[i].load(Ordering::Relaxed) as f64 / rate
            }),
            levels: std::array::from_fn(|i| f32::from_bits(self.meters[i].load(Ordering::Relaxed))),
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
    /// Smoothed output volume.
    volume: f32,
    eq: [EqSettings; SLOTS],
    eq_state: [EqState; SLOTS],
    eq_version: u64,
    /// Smoothed wet share of the EQ per track, 0–1.
    eq_mix: [f32; SLOTS],
    /// Smoothed share of the alternate rendering per track, 0–1.
    alt_mix: [f32; SLOTS],
}

impl Mixer {
    fn render(&mut self, out: &mut [f32]) {
        let shared = &self.shared;
        // Never block the audio thread: if a track is being swapped, output one buffer of silence.
        let Ok(tracks) = shared.tracks.try_lock() else {
            out.fill(0.0);
            return;
        };

        let version = shared.eq_version.load(Ordering::Acquire);
        if version != self.eq_version {
            if let Ok(eq) = shared.eq.try_lock() {
                for i in 0..SLOTS {
                    // Stages that were removed start from silence if they come back.
                    for st in &mut self.eq_state[i][eq[i].count..] {
                        *st = [[0.0; 2]; 2];
                    }
                    if eq[i].count == 0 {
                        self.eq_mix[i] = 0.0;
                    }
                }
                self.eq = *eq;
                self.eq_version = version;
            }
        }

        let mut pos: [u64; SLOTS] = std::array::from_fn(|i| {
            match shared.seek_requests[i].swap(NONE, Ordering::Relaxed) {
                NONE => shared.positions[i].load(Ordering::Relaxed),
                p => p,
            }
        });
        let playing = shared.playing.load(Ordering::Relaxed);
        let active = shared.active.load(Ordering::Relaxed);
        let looping: [bool; SLOTS] = std::array::from_fn(|i| shared.loop_enabled[i].load(Ordering::Relaxed));
        let alt_targets: [f32; SLOTS] = std::array::from_fn(|i| {
            let on = shared.alt_enabled[i].load(Ordering::Relaxed) && tracks[i].alt.is_some();
            if on { 1.0 } else { 0.0 }
        });
        let trim_targets: [f32; SLOTS] =
            std::array::from_fn(|i| f32::from_bits(shared.trims[i].load(Ordering::Relaxed)));
        let volume_target = f32::from_bits(shared.volume.load(Ordering::Relaxed));
        let loops: [(u64, u64); SLOTS] = std::array::from_fn(|i| {
            (shared.loop_start[i].load(Ordering::Relaxed), shared.loop_end[i].load(Ordering::Relaxed))
        });

        let master_target = if playing { 1.0 } else { 0.0 };
        let mut peaks = [0.0f32; SLOTS];
        // Fully faded out and paused: hold position, output silence.
        if !playing && self.master == 0.0 {
            out.fill(0.0);
        } else {
            for frame in out.chunks_mut(self.out_channels) {
                self.master = approach(self.master, master_target, self.fade_step);
                self.volume += (volume_target - self.volume) * TRIM_SMOOTHING * self.fade_step;
                let (mut l, mut r) = (0.0f32, 0.0f32);
                for i in 0..SLOTS {
                    let target = if i == active { 1.0 } else { 0.0 };
                    self.gains[i] = approach(self.gains[i], target, self.fade_step);
                    self.trims[i] += (trim_targets[i] - self.trims[i]) * TRIM_SMOOTHING * self.fade_step;
                    let Some(track) = &tracks[i].track else { continue };
                    self.alt_mix[i] = approach(self.alt_mix[i], alt_targets[i], self.fade_step);
                    if pos[i] < track.frames {
                        let idx = pos[i] as usize * 2;
                        let g = self.gains[i] * self.trims[i] * self.volume * self.master;
                        let (mut sl, mut sr) = (track.samples[idx], track.samples[idx + 1]);
                        if let Some(alt) = tracks[i].alt.as_ref().filter(|_| self.alt_mix[i] > 0.0) {
                            let m = self.alt_mix[i];
                            sl += (alt.samples[idx] - sl) * m;
                            sr += (alt.samples[idx + 1] - sr) * m;
                        }
                        if self.eq[i].count > 0 {
                            let (wl, wr) = run_eq(&self.eq[i], &mut self.eq_state[i], sl, sr);
                            let target = if self.eq[i].enabled { 1.0 } else { 0.0 };
                            let m = approach(self.eq_mix[i], target, self.fade_step);
                            self.eq_mix[i] = m;
                            sl += (wl - sl) * m;
                            sr += (wr - sr) * m;
                        }
                        peaks[i] = peaks[i].max(sl.abs().max(sr.abs()) * self.trims[i] * self.master);
                        l += sl * g;
                        r += sr * g;
                        pos[i] += 1;
                    }
                    let (ls, le) = loops[i];
                    if looping[i] && le != NONE && pos[i] >= le.min(track.frames) {
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
            .all(|(t, &p)| t.track.as_ref().is_none_or(|t| p >= t.frames));
        if playing && all_ended && tracks.iter().any(|t| t.track.is_some()) {
            shared.playing.store(false, Ordering::Relaxed);
        }
        for (slot, p) in shared.positions.iter().zip(pos) {
            slot.store(p, Ordering::Relaxed);
        }
        for (meter, peak) in shared.meters.iter().zip(peaks) {
            meter.store(peak.to_bits(), Ordering::Relaxed);
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
                    gains: std::array::from_fn(|i| if i == 0 { 1.0 } else { 0.0 }),
                    trims: [1.0; SLOTS],
                    volume: 1.0,
                    eq: [EqSettings::default(); SLOTS],
                    eq_state: [[[[0.0; 2]; 2]; MAX_EQ_STAGES]; SLOTS],
                    eq_version: 0,
                    eq_mix: [0.0; SLOTS],
                    alt_mix: [0.0; SLOTS],
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
