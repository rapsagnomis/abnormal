//! Export a track with its EQ match and/or loudness match applied, rendered offline at the
//! file's own sample rate and written as a WAV file.
//!
//! The EQ is the same as auditioned: the chosen moves (biquads, side moves on L − R) or the
//! full match (linear-phase mid/side FIRs). Levels are measured on the result, so the output
//! keeps the track's loudness (EQ only) or lands on the reference's (loudness match), over the
//! same ranges the match was measured on.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};

use crate::decode::AudioData;
use crate::eq::{Filter, Placement};
use crate::{fir, loudness, spectrum};

/// The EQ to render: chosen moves, or the full match's mid and side curves (dB on the grid).
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportEq {
    Moves { filters: Vec<Filter> },
    Full { mid: Vec<f32>, side: Vec<f32> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exported {
    /// Gain applied after the EQ, dB.
    pub gain_db: f64,
    /// Integrated loudness of the result over the measured range, LUFS.
    pub loudness: f64,
    /// Sample peak of the result before it was written, dBFS (above 0 = clipped in 24-bit).
    pub peak_db: f64,
}

/// Frame ranges `[start, end)` to measure loudness over.
pub type Range = (usize, usize);

fn integrated(audio: &AudioData, (start, end): Range) -> Result<f64> {
    loudness::analyze(audio, start, end, false)?
        .stats
        .integrated
        .ok_or_else(|| anyhow!("nothing to measure: silent range"))
}

/// Render `track` with `eq`, set its level (to `reference`'s loudness if given, else to its
/// own), and write it to `path`: 24-bit PCM, or 32-bit float when `float`.
pub fn export(
    path: &Path,
    track: &AudioData,
    track_range: Range,
    eq: Option<&ExportEq>,
    reference: Option<(&AudioData, Range)>,
    float: bool,
) -> Result<Exported> {
    let mono = track.channels.len() == 1;
    let left = &track.channels[0];
    let right = track.channels.get(1).unwrap_or(left);
    let (mut l, mut r) = (left.clone(), right.clone());
    match eq {
        Some(ExportEq::Moves { filters }) => apply_moves(&mut l, &mut r, filters, track.sample_rate as f64),
        Some(ExportEq::Full { mid, side }) => {
            let rate = track.sample_rate as f64;
            let taps = fir::taps_for(rate);
            let freqs = spectrum::grid();
            let interleaved: Vec<f32> = l.iter().zip(&r).flat_map(|(&a, &b)| [a, b]).collect();
            let out = fir::filter_mid_side(
                &interleaved,
                &fir::design(&freqs, mid, rate, taps),
                &fir::design(&freqs, side, rate, taps),
            );
            for (i, frame) in out.chunks_exact(2).enumerate() {
                (l[i], r[i]) = (frame[0], frame[1]);
            }
        }
        None => {}
    }
    let mut out = AudioData {
        sample_rate: track.sample_rate,
        channels: if mono { vec![l] } else { vec![l, r] },
    };

    let target = match reference {
        Some((audio, range)) => integrated(audio, range)?,
        None => integrated(track, track_range)?,
    };
    let gain_db = target - integrated(&out, track_range)?;
    let gain = 10f32.powf(gain_db as f32 / 20.0);
    let mut peak = 0f32;
    for ch in &mut out.channels {
        for s in ch.iter_mut() {
            *s *= gain;
            peak = peak.max(s.abs());
        }
    }

    write_wav(path, &out, float).with_context(|| format!("cannot write {}", path.display()))?;
    Ok(Exported { gain_db, loudness: target, peak_db: 20.0 * (peak as f64).log10() })
}

/// The moves in series, as on playback: stereo moves on both channels, side moves on L − R only.
fn apply_moves(l: &mut [f32], r: &mut [f32], filters: &[Filter], rate: f64) {
    let stages: Vec<_> = filters.iter().map(|f| (f.biquad(rate), f.placement == Placement::Side)).collect();
    let mut state = vec![[[0f64; 2]; 2]; stages.len()];
    for (sl, sr) in l.iter_mut().zip(r.iter_mut()) {
        let mut x = [*sl as f64, *sr as f64];
        for ((q, side), st) in stages.iter().zip(&mut state) {
            if *side {
                let (m, s) = ((x[0] + x[1]) * 0.5, (x[0] - x[1]) * 0.5);
                let s = q.process(&mut st[0], s);
                x = [m + s, m - s];
            } else {
                for (v, z) in x.iter_mut().zip(st.iter_mut()) {
                    *v = q.process(z, *v);
                }
            }
        }
        (*sl, *sr) = (x[0] as f32, x[1] as f32);
    }
}

/// Little-endian RIFF/WAVE: 24-bit PCM (clipped to full scale) or 32-bit IEEE float.
fn write_wav(path: &Path, audio: &AudioData, float: bool) -> Result<()> {
    let channels = audio.channels.len() as u16;
    let bytes_per_sample: u16 = if float { 4 } else { 3 };
    let block_align = channels * bytes_per_sample;
    let data_len = audio.frames() as u64 * block_align as u64;
    let data_len = u32::try_from(data_len).map_err(|_| anyhow!("too long for a WAV file"))?;

    let mut w = BufWriter::new(File::create(path)?);
    w.write_all(b"RIFF")?;
    w.write_all(&(36 + data_len).to_le_bytes())?;
    w.write_all(b"WAVEfmt ")?;
    w.write_all(&16u32.to_le_bytes())?;
    w.write_all(&(if float { 3u16 } else { 1u16 }).to_le_bytes())?;
    w.write_all(&channels.to_le_bytes())?;
    w.write_all(&audio.sample_rate.to_le_bytes())?;
    w.write_all(&(audio.sample_rate * block_align as u32).to_le_bytes())?;
    w.write_all(&block_align.to_le_bytes())?;
    w.write_all(&(bytes_per_sample * 8).to_le_bytes())?;
    w.write_all(b"data")?;
    w.write_all(&data_len.to_le_bytes())?;
    for i in 0..audio.frames() {
        for ch in &audio.channels {
            let s = ch[i];
            if float {
                w.write_all(&s.to_le_bytes())?;
            } else {
                let v = (s.clamp(-1.0, 1.0) as f64 * 8_388_607.0).round() as i32;
                w.write_all(&v.to_le_bytes()[..3])?;
            }
        }
    }
    w.flush()?;
    Ok(())
}
