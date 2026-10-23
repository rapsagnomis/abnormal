//! Psychoacoustic sound quality: how bright/piercing (sharpness) and how harsh (roughness) a
//! track sounds, from models of hearing rather than plain band levels.
//!
//! - Loudness after Zwicker, ISO 532-1:2017 method 1 (stationary, free field), from 1/3-octave
//!   band levels: specific loudness N'(z) in sone/Bark over 0.1–24 Bark, and total loudness N.
//! - Sharpness after DIN 45692:2009, in acum, from N'(z).
//! - Roughness after Daniel & Weber (1997), in asper, from 200 ms frames.
//!
//! Ported from MoSQITo (github.com/Eomys/MoSQITo, Apache License 2.0), whose tables come from the
//! standards and the papers; the slope routine follows Zwicker & Fastl's published BASIC program.
//!
//! These models need sound pressure, so a track is set to a listening level first: its integrated
//! loudness is played at `LISTENING_DB_SPL`. Tracks are therefore compared at matched loudness.

use std::sync::Arc;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use serde::Serialize;

use crate::decode::AudioData;

/// A track's integrated loudness is heard at this level (dB SPL): a moderate listening level.
pub const LISTENING_DB_SPL: f64 = 75.0;
const P_REF: f64 = 2e-5;
/// Loudness and sharpness are measured on blocks this long, seconds.
const BLOCK_SECONDS: f64 = 0.5;
/// Blocks quieter than this (sone) are left out: sharpness of near-silence means nothing.
const MIN_SONE: f64 = 1.0;
/// Roughness frames (Daniel & Weber use 200 ms) and how many are measured at most.
const ROUGHNESS_FRAME_SECONDS: f64 = 0.2;
const ROUGHNESS_MAX_FRAMES: usize = 120;

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PsychoStats {
    /// Median over the range's 0.5 s blocks, acum.
    pub sharpness: Option<f64>,
    /// The sharpest moments: 90th percentile over blocks, acum.
    pub sharpness_p90: Option<f64>,
    /// Median over sampled 200 ms frames, asper.
    pub roughness: Option<f64>,
    /// 90th percentile over frames, asper.
    pub roughness_p90: Option<f64>,
    /// Median loudness over blocks at the listening level, sone.
    pub loudness: Option<f64>,
}

/// Sharpness and roughness of frames `start..end`, heard with `integrated` (LUFS) at the
/// listening level.
pub fn analyze(audio: &AudioData, start: usize, end: usize, integrated: Option<f64>) -> PsychoStats {
    let Some(integrated) = integrated.filter(|v| v.is_finite()) else { return PsychoStats::default() };
    let end = end.min(audio.frames());
    if end <= start {
        return PsychoStats::default();
    }
    // Mono, in pascals: full-scale RMS at the integrated loudness plays at the listening level.
    let gain = P_REF * 10f64.powf((LISTENING_DB_SPL - integrated) / 20.0);
    let channels = audio.channels.len() as f64;
    let mono: Vec<f64> = (start..end).map(|i| audio.channels.iter().map(|c| c[i] as f64).sum::<f64>() / channels * gain).collect();
    let fs = audio.sample_rate as f64;

    let mut sharp = Vec::new();
    let mut loud = Vec::new();
    let block = (BLOCK_SECONDS * fs) as usize;
    let mut spectrum = BlockSpectrum::new(block);
    for chunk in mono.chunks(block).filter(|c| c.len() * 2 >= block) {
        let levels = spectrum.third_octave_levels(chunk, fs);
        let (n, specific) = loudness(&levels);
        if n >= MIN_SONE {
            loud.push(n);
            if let Some(s) = sharpness(n, &specific) {
                sharp.push(s);
            }
        }
    }

    let rough = roughness_frames(&mono, fs);
    PsychoStats {
        sharpness: percentile(&mut sharp, 0.5),
        sharpness_p90: percentile(&mut sharp, 0.9),
        roughness: percentile(&mut rough.clone(), 0.5),
        roughness_p90: percentile(&mut rough.clone(), 0.9),
        loudness: percentile(&mut loud, 0.5),
    }
}

fn percentile(values: &mut [f64], q: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let pos = q * (values.len() - 1) as f64;
    let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
    Some(values[lo] + (values[hi] - values[lo]) * (pos - lo as f64))
}

// ── 1/3-octave levels ──────────────────────────────────────────────────────────────────────────

/// The 28 bands Zwicker's method uses: 25 Hz – 12.5 kHz (nominal centres).
pub const THIRD_OCTAVES: usize = 28;

/// Power spectrum of one block (Hann window), summed into 1/3-octave bands.
struct BlockSpectrum {
    fft: Arc<dyn Fft<f64>>,
    window: Vec<f64>,
    buf: Vec<Complex<f64>>,
}

impl BlockSpectrum {
    fn new(len: usize) -> Self {
        let n = len.next_power_of_two();
        let window = (0..len).map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / len as f64).cos()).collect();
        Self { fft: FftPlanner::new().plan_fft_forward(n), window, buf: vec![Complex::default(); n] }
    }

    /// Band levels in dB SPL of a block in pascals (shorter blocks are zero-padded).
    fn third_octave_levels(&mut self, block: &[f64], fs: f64) -> [f64; THIRD_OCTAVES] {
        let n = self.buf.len();
        let w = &self.window[..block.len()];
        let w_power: f64 = w.iter().map(|v| v * v).sum();
        for (i, b) in self.buf.iter_mut().enumerate() {
            *b = Complex::new(block.get(i).map_or(0.0, |x| x * w[i]), 0.0);
        }
        self.fft.process(&mut self.buf);
        // One-sided power per bin, scaled so the bins sum to the block's mean square.
        // (Parseval: Σ|X|² = n·Σ|x·w|², and Σ|x·w|² / Σw² is the mean square.)
        let scale = 1.0 / (n as f64 * w_power);
        let power: Vec<f64> = (0..=n / 2).map(|k| self.buf[k].norm_sqr() * scale * if k == 0 || k == n / 2 { 1.0 } else { 2.0 }).collect();
        band_levels(&power, fs / n as f64)
    }
}

/// Sum a one-sided power spectrum (Pa² per bin, bins `bin_hz` apart) into 1/3-octave levels,
/// through 3rd-order Butterworth band-pass responses like ISO 532-1's filter bank: sounds spill a
/// little into the neighbouring bands, which the standard's loudness values include.
fn band_levels(power: &[f64], bin_hz: f64) -> [f64; THIRD_OCTAVES] {
    // Relative bandwidth of a 1/3-octave band (base 10), for |H|² = 1 / (1 + ((f/fc − fc/f)/B)^6).
    let b = 10f64.powf(0.05) - 10f64.powf(-0.05);
    let mut levels = [0.0; THIRD_OCTAVES];
    for (k, level) in levels.iter_mut().enumerate() {
        let centre = 1000.0 * 10f64.powf((k as f64 - 16.0) / 10.0);
        // Beyond 1.5 octaves either side the response is below −60 dB.
        let first = ((centre * 2f64.powf(-1.5)) / bin_hz).floor().max(1.0) as usize;
        let last = (((centre * 2f64.powf(1.5)) / bin_hz).ceil() as usize).min(power.len().saturating_sub(1));
        let mut sum = 0.0;
        for (i, p) in power.iter().enumerate().take(last + 1).skip(first) {
            let r = i as f64 * bin_hz / centre;
            let x = (r - 1.0 / r) / b;
            sum += p / (1.0 + x.powi(6));
        }
        *level = if sum > 0.0 { 10.0 * (sum / (P_REF * P_REF)).log10() } else { -60.0 };
    }
    levels
}

// ── Loudness (Zwicker, ISO 532-1) ──────────────────────────────────────────────────────────────

/// Ranges of 1/3-octave levels for the low-frequency correction (equal-loudness contours).
const RAP: [f64; 8] = [45.0, 55.0, 65.0, 71.0, 80.0, 90.0, 100.0, 120.0];
/// Reduction of the 11 lowest 1/3-octave levels (25–250 Hz) within each of the `RAP` ranges.
const DLL: [[f64; 11]; 8] = [
    [-32.0, -24.0, -16.0, -10.0, -5.0, 0.0, -7.0, -3.0, 0.0, -2.0, 0.0],
    [-29.0, -22.0, -15.0, -10.0, -4.0, 0.0, -7.0, -2.0, 0.0, -2.0, 0.0],
    [-27.0, -19.0, -14.0, -9.0, -4.0, 0.0, -6.0, -2.0, 0.0, -2.0, 0.0],
    [-25.0, -17.0, -12.0, -9.0, -3.0, 0.0, -5.0, -2.0, 0.0, -2.0, 0.0],
    [-23.0, -16.0, -11.0, -7.0, -3.0, 0.0, -4.0, -1.0, 0.0, -1.0, 0.0],
    [-20.0, -14.0, -10.0, -6.0, -3.0, 0.0, -4.0, -1.0, 0.0, -1.0, 0.0],
    [-18.0, -12.0, -9.0, -6.0, -2.0, 0.0, -3.0, -1.0, 0.0, -1.0, 0.0],
    [-15.0, -10.0, -8.0, -4.0, -2.0, 0.0, -3.0, -1.0, 0.0, -1.0, 0.0],
];
/// Critical band level at the threshold in quiet.
const LTQ: [f64; 20] = [30.0, 18.0, 12.0, 8.0, 7.0, 6.0, 5.0, 4.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0];
/// Transmission of the outer ear (free field).
const A0: [f64; 20] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -0.5, -1.6, -3.2, -5.4, -5.6, -4.0, -1.5, 2.0, 5.0, 12.0];
/// From 1/3-octave band levels to critical band levels.
const DCB: [f64; 20] = [-0.25, -0.6, -0.8, -0.8, -0.5, 0.0, 0.5, 1.1, 1.5, 1.7, 1.8, 1.8, 1.7, 1.6, 1.4, 1.2, 0.8, 0.5, 0.0, -0.5];
/// Upper edges of the approximated critical bands, Bark.
const ZUP: [f64; 21] = [0.9, 1.8, 2.8, 3.5, 4.4, 5.4, 6.6, 7.9, 9.2, 10.6, 12.3, 13.8, 15.2, 16.7, 18.1, 19.3, 20.6, 21.8, 22.7, 23.6, 24.0];
/// Ranges of specific loudness for the steepness of the upper slopes.
const RNS: [f64; 18] = [21.5, 18.0, 15.1, 11.5, 9.0, 6.1, 4.4, 3.1, 2.13, 1.36, 0.82, 0.42, 0.30, 0.22, 0.15, 0.10, 0.035, 0.0];
/// Steepness of the upper slopes (sone/Bark per Bark) per `RNS` range and critical band group.
const USL: [[f64; 8]; 18] = [
    [13.0, 8.2, 6.3, 5.5, 5.5, 5.5, 5.5, 5.5],
    [9.0, 7.5, 6.0, 5.1, 4.5, 4.5, 4.5, 4.5],
    [7.8, 6.7, 5.6, 4.9, 4.4, 3.9, 3.9, 3.9],
    [6.2, 5.4, 4.6, 4.0, 3.5, 3.2, 3.2, 3.2],
    [4.5, 3.8, 3.6, 3.2, 2.9, 2.7, 2.7, 2.7],
    [3.7, 3.0, 2.8, 2.35, 2.2, 2.2, 2.2, 2.2],
    [2.9, 2.3, 2.1, 1.9, 1.8, 1.7, 1.7, 1.7],
    [2.4, 1.7, 1.5, 1.35, 1.3, 1.3, 1.3, 1.3],
    [1.95, 1.45, 1.3, 1.15, 1.1, 1.1, 1.1, 1.1],
    [1.5, 1.2, 0.94, 0.86, 0.82, 0.82, 0.82, 0.82],
    [0.72, 0.67, 0.64, 0.63, 0.62, 0.62, 0.62, 0.62],
    [0.59, 0.53, 0.51, 0.50, 0.42, 0.42, 0.42, 0.42],
    [0.40, 0.33, 0.26, 0.24, 0.24, 0.22, 0.22, 0.22],
    [0.27, 0.21, 0.20, 0.18, 0.17, 0.17, 0.17, 0.17],
    [0.16, 0.15, 0.14, 0.12, 0.11, 0.11, 0.11, 0.11],
    [0.12, 0.11, 0.10, 0.08, 0.08, 0.08, 0.08, 0.08],
    [0.09, 0.08, 0.07, 0.06, 0.06, 0.06, 0.06, 0.05],
    [0.06, 0.05, 0.03, 0.02, 0.02, 0.02, 0.02, 0.02],
];
/// Specific loudness is given every 0.1 Bark from 0.1 to 24 Bark.
pub const BARK_STEPS: usize = 240;

/// Total loudness (sone) and specific loudness (sone/Bark, 240 steps of 0.1 Bark) from 28
/// 1/3-octave levels in dB SPL, free field.
pub fn loudness(levels: &[f64; THIRD_OCTAVES]) -> (f64, [f64; BARK_STEPS]) {
    slopes(&core_loudness(levels))
}

/// Core loudness of the 20 critical bands (plus a 21st, empty, for the last slope).
fn core_loudness(levels: &[f64; THIRD_OCTAVES]) -> [f64; 21] {
    // Low frequencies: correct by the equal-loudness contours, then pool 1/3 octaves 1–6, 7–9 and
    // 10–11 into the first three critical bands.
    let mut ti = [0.0; 11];
    for (i, t) in ti.iter_mut().enumerate() {
        let level = levels[i];
        let j = (0..8).find(|&j| level <= RAP[j] - DLL[j][i]).unwrap_or(7);
        *t = 10f64.powf((level + DLL[j][i]) / 10.0);
    }
    let pooled = [ti[0..6].iter().sum::<f64>(), ti[6..9].iter().sum(), ti[9..11].iter().sum()];
    let mut le = [0.0; 20];
    le.copy_from_slice(&levels[8..28]);
    for (l, g) in le.iter_mut().zip(pooled) {
        *l = if g > 0.0 { 10.0 * g.log10() } else { 0.0 };
    }

    let s = 0.25;
    let mut nm = [0.0; 21];
    for i in 0..20 {
        let mut l = le[i] - A0[i];
        if l > LTQ[i] {
            l -= DCB[i];
            let n = 0.0635 * 10f64.powf(0.025 * LTQ[i]) * ((1.0 - s + s * 10f64.powf((l - LTQ[i]) / 10.0)).powf(0.25) - 1.0);
            nm[i] = n.max(0.0);
        }
    }
    // The threshold varies within the lowest critical band.
    let korry = 0.4 + 0.32 * nm[0].powf(0.2);
    if korry <= 1.0 {
        nm[0] *= korry;
    }
    nm
}

/// Spread the core loudness over the Bark scale with the upper masking slopes; the area under
/// N'(z) is the total loudness. After Zwicker & Fastl's program (DIN 45631).
fn slopes(nm: &[f64; 21]) -> (f64, [f64; BARK_STEPS]) {
    const EPS: f64 = 1e-9;
    let mut specific = [0.0; BARK_STEPS];
    let (mut total, mut z1, mut n1) = (0.0, 0.0, 0.0f64);
    let mut j = 0usize;
    let mut step = 0usize; // next 0.1-Bark step to fill: z = (step + 1) · 0.1
    let z_at = |step: usize| (step + 1) as f64 * 0.1;
    for i in 0..21usize {
        let ig = i.saturating_sub(1).min(7);
        loop {
            let (z2, n2);
            if n1 > nm[i] + EPS {
                // Falling: down the upper slope, as steep as the current loudness range allows.
                let usl = USL[j][ig];
                let mut n2v = RNS[j].max(nm[i]);
                let mut dz = (n1 - n2v) / usl;
                let mut z2v = z1 + dz;
                if z2v > ZUP[i] {
                    z2v = ZUP[i];
                    dz = z2v - z1;
                    n2v = n1 - dz * usl;
                }
                total += dz * (n1 + n2v) / 2.0;
                while step < BARK_STEPS && z_at(step) <= z2v + EPS {
                    specific[step] = n1 - (z_at(step) - z1) * usl;
                    step += 1;
                }
                (z2, n2) = (z2v, n2v);
                // Reached the end of this loudness range: continue with the next, gentler one.
                if (n2 - RNS[j]).abs() < EPS {
                    j = (j + 1).min(17);
                }
            } else {
                if n1 < nm[i] - EPS {
                    j = RNS.iter().position(|&r| r < nm[i]).unwrap_or(17);
                }
                (z2, n2) = (ZUP[i], nm[i]);
                total += n2 * (z2 - z1);
                while step < BARK_STEPS && z_at(step) <= z2 + EPS {
                    specific[step] = n2;
                    step += 1;
                }
            }
            z1 = z2;
            n1 = n2;
            if z2 >= ZUP[i] - EPS {
                break;
            }
        }
    }
    (total.max(0.0), specific.map(|v| v.max(0.0)))
}

// ── Sharpness (DIN 45692) ──────────────────────────────────────────────────────────────────────

/// Sharpness in acum from total and specific loudness; none for (near) silence.
pub fn sharpness(n: f64, specific: &[f64; BARK_STEPS]) -> Option<f64> {
    if n < 0.1 {
        return None;
    }
    let weighted: f64 = specific
        .iter()
        .enumerate()
        .map(|(k, &ns)| {
            let z = (k + 1) as f64 * 0.1;
            let g = if z > 15.8 { 0.15 * (0.42 * (z - 15.8)).exp() + 0.85 } else { 1.0 };
            ns * g * z * 0.1
        })
        .sum();
    Some(0.11 * weighted / n)
}

// ── Roughness (Daniel & Weber 1997) ────────────────────────────────────────────────────────────

/// Roughness of evenly spread 200 ms frames of a signal in pascals, using the available cores.
fn roughness_frames(signal: &[f64], fs: f64) -> Vec<f64> {
    let len = (ROUGHNESS_FRAME_SECONDS * fs) as usize;
    if signal.len() < len {
        return Vec::new();
    }
    let count = ((signal.len() - len) / len + 1).min(ROUGHNESS_MAX_FRAMES);
    let hop = if count > 1 { (signal.len() - len) / (count - 1) } else { 0 };
    let starts: Vec<usize> = (0..count).map(|i| i * hop).collect();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    let chunk = starts.len().div_ceil(threads).max(1);
    let model = RoughnessModel::new(len, fs);
    std::thread::scope(|scope| {
        let handles: Vec<_> = starts
            .chunks(chunk)
            .map(|part| {
                let model = &model;
                scope.spawn(move || part.iter().map(|&s| model.roughness(&signal[s..s + len])).collect::<Vec<_>>())
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
    })
}

const CHANNELS: usize = 47;

/// Everything about the roughness model that depends only on the frame length and rate.
pub struct RoughnessModel {
    len: usize,
    /// Length of the mirrored spectrum the model works on (2 × len/2).
    n: usize,
    fs: f64,
    window: Vec<f64>,
    /// Frequency (Hz) and Bark of the one-sided bins. Bin k is taken as (k + 1)·fs/len, as in the
    /// reference implementation.
    freqs: Vec<f64>,
    barks: Vec<f64>,
    /// Outer/middle ear transmission (linear) and threshold (dB) per bin.
    ear: Vec<f64>,
    threshold: Vec<f64>,
    /// Lowest excitation (dB) counted in each of the 47 channels.
    min_excitation: [f64; CHANNELS],
    /// Modulation-frequency weighting per channel and envelope bin.
    h: Vec<Vec<f64>>,
    gzi: [f64; CHANNELS],
    fft: Arc<dyn Fft<f64>>,
    ifft: Arc<dyn Fft<f64>>,
    frame_fft: Arc<dyn Fft<f64>>,
}

impl RoughnessModel {
    pub fn new(len: usize, fs: f64) -> Self {
        let half = len / 2;
        let n = 2 * half;
        // Blackman window, normalised to unit sum (×1.42: RMS amplitude spectrum, as MoSQITo).
        let window: Vec<f64> = (0..len)
            .map(|i| {
                let x = 2.0 * std::f64::consts::PI * i as f64 / (len - 1) as f64;
                0.42 - 0.5 * x.cos() + 0.08 * (2.0 * x).cos()
            })
            .collect();
        let sum: f64 = window.iter().sum();
        let window = window.into_iter().map(|w| w / sum).collect();
        let freqs: Vec<f64> = (1..=half).map(|k| k as f64 * fs / len as f64).collect();
        let barks: Vec<f64> = freqs.iter().map(|&f| freq_to_bark(f)).collect();
        let ear = barks.iter().map(|&b| 10f64.powf(interp(b, &EAR_X, &EAR_Y) / 20.0)).collect();
        let threshold: Vec<f64> = barks.iter().map(|&b| interp(b, &LTQ_R_X, &LTQ_R_Y)).collect();
        // Channel centres zi = 0.5…23.5 Bark, at their (fractional) bin position.
        let bin_index: Vec<f64> = (1..=half).map(|k| k as f64).collect();
        let min_excitation = std::array::from_fn(|i| {
            let zb = bark_to_freq((i + 1) as f64 / 2.0) * n as f64 / fs;
            interp(zb, &bin_index, &threshold)
        });
        let gzi = std::array::from_fn(|i| interp((i + 1) as f64 / 2.0, &GZI_X, &GZI_Y));
        let mut planner = FftPlanner::new();
        Self {
            len,
            n,
            fs,
            window,
            freqs,
            barks,
            ear,
            threshold,
            min_excitation,
            h: h_weighting(n, fs),
            gzi,
            fft: planner.plan_fft_forward(n),
            ifft: planner.plan_fft_inverse(n),
            frame_fft: planner.plan_fft_forward(len),
        }
    }

    /// Roughness (asper) of one frame of `len` samples in pascals.
    pub fn roughness(&self, frame: &[f64]) -> f64 {
        let (n, half) = (self.n, self.n / 2);
        let mut buf: Vec<Complex<f64>> = frame.iter().zip(&self.window).map(|(x, w)| Complex::new(x * w, 0.0)).collect();
        self.frame_fft.process(&mut buf);
        // One-sided spectrum through the ear (the mirrored half is zeroed by the ear filter in the
        // reference implementation, so only these bins carry energy).
        let spec: Vec<Complex<f64>> = (0..half).map(|k| buf[k] * 1.42 * self.ear[k]).collect();
        let module: Vec<f64> = spec.iter().map(|c| c.norm()).collect();
        let db: Vec<f64> = module.iter().map(|&m| if m > 0.0 { 20.0 * (m / P_REF).log10() } else { -200.0 }).collect();

        // Audible bins and how each one excites the 47 channels (lower slope −27 dB/Bark, upper
        // slope level-dependent), above each channel's threshold.
        struct Bin {
            k: usize,
            low: i64,
            high: i64,
            slopes: [f64; CHANNELS],
        }
        let bins: Vec<Bin> = (0..half)
            .filter(|&k| db[k] > self.threshold[k])
            .map(|k| {
                let (level, b) = (db[k], self.barks[k]);
                let s2 = (-24.0 - 230.0 / self.freqs[k] + 0.2 * level).min(0.0);
                let low = (2.0 * b).floor() as i64 - 1;
                let high = (2.0 * b).ceil() as i64 - 1;
                let mut slopes = [0.0; CHANNELS];
                for (j, s) in slopes.iter_mut().enumerate() {
                    let jj = j as i64;
                    let sl = if jj <= low {
                        -27.0 * (b - (j + 1) as f64 * 0.5) + level
                    } else if jj >= high {
                        s2 * ((j + 1) as f64 * 0.5 - b) + level
                    } else {
                        continue;
                    };
                    if sl > self.min_excitation[j] {
                        *s = 10f64.powf(sl / 20.0) * P_REF;
                    }
                }
                Bin { k, low, high, slopes }
            })
            .collect();

        let mut h_bp = vec![vec![0.0; n]; CHANNELS];
        let mut depth = [0.0; CHANNELS];
        let mut exc = vec![Complex::default(); n];
        for i in 0..CHANNELS {
            exc.iter_mut().for_each(|c| *c = Complex::default());
            let ii = i as i64;
            for bin in &bins {
                let ampl = if bin.low == ii || bin.high == ii {
                    1.0
                } else if bin.high > ii {
                    bin.slopes.get(i + 1).copied().unwrap_or(0.0) / module[bin.k]
                } else if i > 0 {
                    bin.slopes[i - 1] / module[bin.k]
                } else {
                    0.0
                };
                exc[bin.k] = spec[bin.k] * ampl;
            }
            // Excitation envelope in time, its DC and its band-passed modulation.
            self.ifft.process(&mut exc);
            let temporal: Vec<f64> = exc.iter().map(|c| c.re.abs()).collect(); // n · ifft, unnormalised
            let h0 = temporal.iter().sum::<f64>() / n as f64;
            let mut env: Vec<Complex<f64>> = temporal.iter().map(|&t| Complex::new(t - h0, 0.0)).collect();
            self.fft.process(&mut env);
            for (e, w) in env.iter_mut().zip(&self.h[i]) {
                *e *= w;
            }
            self.ifft.process(&mut env);
            let band = &mut h_bp[i];
            for (b, e) in band.iter_mut().zip(&env) {
                *b = 2.0 * e.re / n as f64;
            }
            let rms = (band.iter().map(|v| v * v).sum::<f64>() / n as f64).sqrt();
            depth[i] = if h0 > 0.0 { (rms / h0).min(1.0) } else { 0.0 };
        }

        // Correlation between channels two apart: roughness needs modulation shared across bands.
        let mut ki = [0.0; CHANNELS];
        for i in 0..CHANNELS - 2 {
            ki[i] = correlation(&h_bp[i], &h_bp[i + 2]);
        }
        let r = |i: usize, k: f64| self.gzi[i] * (depth[i] * k).powi(2);
        let mut total = r(0, ki[0]) + r(1, ki[1]);
        for i in 2..45 {
            total += r(i, ki[i] * ki[i - 2]);
        }
        total += r(45, ki[43]) + r(46, ki[44]);
        let _ = (self.len, self.fs);
        0.25 * total
    }
}

fn correlation(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len() as f64;
    let (ma, mb) = (a.iter().sum::<f64>() / n, b.iter().sum::<f64>() / n);
    let (mut cov, mut va, mut vb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        cov += (x - ma) * (y - mb);
        va += (x - ma) * (x - ma);
        vb += (y - mb) * (y - mb);
    }
    if va > 0.0 && vb > 0.0 { cov / (va * vb).sqrt() } else { 0.0 }
}

/// Modulation-frequency weightings H_i over the envelope spectrum's bins (Daniel & Weber fig. 2:
/// H2, H5, H16, H21 and H42 given, the other channels copy their neighbours).
fn h_weighting(n: usize, fs: f64) -> Vec<Vec<f64>> {
    let curve = |xs: &[f64], ys: &[f64], last_hz: f64| {
        let last = ((last_hz / fs) * n as f64).floor() as usize;
        let mut h = vec![0.0; n];
        for (j, v) in h.iter_mut().enumerate().take(last).skip(2) {
            *v = interp(j as f64 * fs / n as f64, xs, ys);
        }
        h
    };
    let h2 = curve(&H2_X, &H2_Y, 358.0);
    let h5 = curve(&H5_X, &H5_Y, 502.0);
    let h16 = curve(&H16_X, &H16_Y, 502.0);
    let h21 = curve(&H21_X, &H21_Y, 502.0);
    let h42 = curve(&H42_X, &H42_Y, 502.0);
    (0..CHANNELS)
        .map(|i| match i {
            0..=3 => h2.clone(),
            4..=14 => h5.clone(),
            15..=19 => h16.clone(),
            20..=40 => h21.clone(),
            _ => h42.clone(),
        })
        .collect()
}

/// Linear interpolation, clamped at the ends (like numpy.interp).
fn interp(x: f64, xs: &[f64], ys: &[f64]) -> f64 {
    if x <= xs[0] {
        return ys[0];
    }
    let last = xs.len() - 1;
    if x >= xs[last] {
        return ys[last];
    }
    let i = xs.partition_point(|&v| v <= x).max(1);
    let (x0, x1, y0, y1) = (xs[i - 1], xs[i], ys[i - 1], ys[i]);
    if x1 == x0 { y0 } else { y0 + (y1 - y0) * (x - x0) / (x1 - x0) }
}

const BARK_FREQS: [f64; 50] = [
    0.0, 50.0, 100.0, 150.0, 200.0, 250.0, 300.0, 350.0, 400.0, 450.0, 510.0, 570.0, 630.0, 700.0, 770.0, 840.0, 920.0, 1000.0,
    1080.0, 1170.0, 1270.0, 1370.0, 1480.0, 1600.0, 1720.0, 1850.0, 2000.0, 2150.0, 2320.0, 2500.0, 2700.0, 2900.0, 3150.0,
    3400.0, 3700.0, 4000.0, 4400.0, 4800.0, 5300.0, 5800.0, 6400.0, 7000.0, 7700.0, 8500.0, 9500.0, 10500.0, 12000.0, 13500.0,
    15500.0, 20000.0,
];
fn bark_axis() -> [f64; 50] {
    std::array::from_fn(|i| i as f64 * 0.5)
}
fn freq_to_bark(f: f64) -> f64 {
    interp(f, &BARK_FREQS, &bark_axis())
}
fn bark_to_freq(z: f64) -> f64 {
    interp(z, &bark_axis(), &BARK_FREQS)
}

/// Outer-to-inner ear transmission, dB over Bark (Zwicker & Fastl fig. 8.18).
const EAR_X: [f64; 22] = [0.0, 10.0, 12.0, 13.0, 14.0, 15.0, 16.0, 16.5, 17.0, 18.0, 18.5, 19.0, 20.0, 21.0, 21.5, 22.0, 22.5, 23.0, 23.5, 24.0, 25.0, 26.0];
const EAR_Y: [f64; 22] = [
    0.0, 0.0, 1.15, 2.31, 3.85, 5.62, 6.92, 7.38, 6.92, 4.23, 2.31, 0.0, -1.43, -2.59, -3.57, -5.19, -7.41, -11.3, -20.0, -40.0, -130.0, -999.0,
];
/// Threshold in quiet for the roughness model, dB over Bark.
const LTQ_R_X: [f64; 27] = [
    0.0, 0.01, 0.17, 0.8, 1.0, 1.5, 2.0, 3.3, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0, 13.3, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0, 21.0, 22.0, 23.0,
    24.0, 24.5, 25.0,
];
const LTQ_R_Y: [f64; 27] = [
    130.0, 70.0, 60.0, 30.0, 25.0, 20.0, 15.0, 10.0, 8.1, 6.3, 5.0, 3.5, 2.5, 1.7, 0.0, -2.5, -4.0, -3.7, -1.5, 1.4, 3.8, 5.0, 7.5, 15.0,
    48.0, 60.0, 130.0,
];
/// Aures' weighting of specific roughness over Bark.
const GZI_X: [f64; 25] = [
    0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0, 21.0, 22.0, 23.0, 24.0,
];
const GZI_Y: [f64; 25] = [
    0.15, 0.26, 0.38, 0.47, 0.54, 0.65, 0.76, 0.83, 0.90, 0.98, 0.98, 0.90, 0.80, 0.70, 0.62, 0.54, 0.49, 0.43, 0.39, 0.35, 0.30, 0.30,
    0.30, 0.30, 0.30,
];
const H2_X: [f64; 15] = [0.0, 17.0, 23.0, 25.0, 32.0, 37.0, 48.0, 67.0, 90.0, 114.0, 171.0, 206.0, 247.0, 294.0, 358.0];
const H2_Y: [f64; 15] = [0.0, 0.8, 0.95, 0.975, 1.0, 0.975, 0.9, 0.8, 0.7, 0.6, 0.4, 0.3, 0.2, 0.1, 0.0];
const H5_X: [f64; 14] = [0.0, 32.0, 43.0, 56.0, 69.0, 92.0, 120.0, 142.0, 165.0, 231.0, 277.0, 331.0, 397.0, 502.0];
const H5_Y: [f64; 14] = [0.0, 0.8, 0.95, 1.0, 0.975, 0.9, 0.8, 0.7, 0.6, 0.4, 0.3, 0.2, 0.1, 0.0];
const H16_X: [f64; 20] = [
    0.0, 23.5, 34.0, 47.0, 56.0, 63.0, 79.0, 100.0, 115.0, 135.0, 159.0, 172.0, 194.0, 215.0, 244.0, 290.0, 348.0, 415.0, 500.0, 645.0,
];
const H16_Y: [f64; 20] = [0.0, 0.4, 0.6, 0.8, 0.9, 0.95, 1.0, 0.975, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0];
const H21_X: [f64; 18] = [0.0, 19.0, 44.0, 52.5, 58.0, 75.0, 101.5, 114.5, 132.5, 143.5, 165.5, 197.5, 241.0, 290.0, 348.0, 415.0, 500.0, 645.0];
const H21_Y: [f64; 18] = [0.0, 0.4, 0.8, 0.9, 0.95, 1.0, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0];
const H42_X: [f64; 19] = [0.0, 15.0, 41.0, 49.0, 53.0, 64.0, 71.0, 88.0, 94.0, 106.0, 115.0, 137.0, 180.0, 238.0, 290.0, 348.0, 415.0, 500.0, 645.0];
const H42_Y: [f64; 19] = [0.0, 0.4, 0.8, 0.9, 0.965, 0.99, 1.0, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0];

/// 1/3-octave levels of a signal in pascals, for tests: the whole signal as one block.
#[cfg(test)]
pub fn third_octave_levels_of(signal: &[f64], fs: f64) -> [f64; THIRD_OCTAVES] {
    BlockSpectrum::new(signal.len()).third_octave_levels(signal, fs)
}
