//! Long-term average spectrum (tonal balance) and mid/side spectra (stereo width per frequency).
//!
//! Spectra are Welch averages of Hann-windowed FFTs over the gated part of the range, smoothed to
//! 1/6 octave and sampled on a shared log-frequency grid, so A and B line up point for point.

use realfft::RealFftPlanner;
use serde::Serialize;

use crate::decode::AudioData;

const FFT_SIZE: usize = 16384;
const HOP: usize = FFT_SIZE / 2;
/// Frames this far below the average frame level are skipped (silence, fade tails).
const FRAME_GATE_DB: f64 = -20.0;
/// "Loudest parts" gating, as in Matchering: the range is cut into equal pieces of at most this
/// many seconds, and only pieces whose mid power is at least the mean over all pieces are used.
const LOUDEST_PIECE_SECONDS: f64 = 15.0;

pub const GRID_MIN_HZ: f64 = 20.0;
pub const GRID_MAX_HZ: f64 = 20000.0;
/// Grid resolution (points per octave) and smoothing width (octaves).
const POINTS_PER_OCTAVE: f64 = 24.0;
const SMOOTHING_OCTAVES: f64 = 1.0 / 6.0;
/// Range used to fit the spectral tilt.
const TILT_RANGE_HZ: (f64, f64) = (50.0, 16000.0);
/// Floor for spectrum values, dB, so empty bands serialise as numbers.
const FLOOR_DB: f64 = -120.0;

/// Named bands for the band tables (lower edge, upper edge).
pub const BANDS: [(&str, f64, f64); 7] = [
    ("Sub", 20.0, 60.0),
    ("Bass", 60.0, 250.0),
    ("Low-mid", 250.0, 500.0),
    ("Mid", 500.0, 2000.0),
    ("Upper-mid", 2000.0, 4000.0),
    ("Presence", 4000.0, 8000.0),
    ("Air", 8000.0, 20000.0),
];

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Band {
    pub name: &'static str,
    pub low: f64,
    pub high: f64,
    /// Energy in the band relative to integrated loudness, dB.
    pub level: Option<f64>,
    /// Side − mid energy in the band, dB (0 = as wide as uncorrelated L/R, −∞ = mono).
    pub width: Option<f64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpectrumReport {
    /// Shared log-spaced frequency grid, Hz.
    pub freqs: Vec<f64>,
    /// Energy per 1/6 octave relative to integrated loudness, dB. Pink noise is flat.
    pub level: Vec<f32>,
    /// Side − mid energy per 1/6 octave, dB; null where the band is silent.
    pub width: Vec<Option<f32>>,
    pub bands: Vec<Band>,
    /// Energy-weighted mean frequency, Hz.
    pub centroid: Option<f64>,
    /// Slope of `level` against log2(frequency), dB/octave (pink noise = 0).
    pub tilt: Option<f64>,
}

/// Averaged power per FFT bin, scaled so the sum over bins is the mean-square signal power.
struct Psd {
    mid: Vec<f64>,
    side: Vec<f64>,
    bin_hz: f64,
}

fn db(power: f64) -> f64 {
    10.0 * power.log10()
}

pub fn grid() -> Vec<f64> {
    let n = ((GRID_MAX_HZ / GRID_MIN_HZ).log2() * POINTS_PER_OCTAVE).round() as usize;
    (0..=n).map(|i| GRID_MIN_HZ * 2f64.powf(i as f64 / POINTS_PER_OCTAVE)).collect()
}

/// `integrated` (LUFS) normalises the levels so tracks of different loudness compare directly.
pub fn analyze(audio: &AudioData, start: usize, end: usize, integrated: Option<f64>) -> SpectrumReport {
    let freqs = grid();
    let Some(psd) = average_psd(audio, start, end, false) else {
        return SpectrumReport {
            level: vec![FLOOR_DB as f32; freqs.len()],
            width: vec![None; freqs.len()],
            bands: BANDS
                .iter()
                .map(|&(name, low, high)| Band { name, low, high, level: None, width: None })
                .collect(),
            freqs,
            centroid: None,
            tilt: None,
        };
    };

    let offset = -integrated.unwrap_or(0.0);
    let total: Vec<f64> = psd.mid.iter().zip(&psd.side).map(|(m, s)| m + s).collect();

    let level: Vec<f32> = freqs
        .iter()
        .map(|&f| {
            let (lo, hi) = smoothing_band(f);
            let e = band_energy(&total, psd.bin_hz, lo, hi);
            (db(e) + offset).max(FLOOR_DB) as f32
        })
        .collect();

    let width: Vec<Option<f32>> = freqs
        .iter()
        .map(|&f| {
            let (lo, hi) = smoothing_band(f);
            width_db(band_energy(&psd.mid, psd.bin_hz, lo, hi), band_energy(&psd.side, psd.bin_hz, lo, hi))
                .map(|w| w as f32)
        })
        .collect();

    let bands = BANDS
        .iter()
        .map(|&(name, low, high)| {
            let e = band_energy(&total, psd.bin_hz, low, high);
            Band {
                name,
                low,
                high,
                level: (e > 0.0).then(|| db(e) + offset),
                width: width_db(
                    band_energy(&psd.mid, psd.bin_hz, low, high),
                    band_energy(&psd.side, psd.bin_hz, low, high),
                ),
            }
        })
        .collect();

    SpectrumReport {
        centroid: centroid(&total, psd.bin_hz),
        tilt: tilt(&freqs, &level),
        freqs,
        level,
        width,
        bands,
    }
}

/// Mid and side energy per 1/6 octave on the shared grid, dB (not loudness-normalised: only
/// differences between them, and between tracks after an offset is removed, are meaningful).
pub struct MidSide {
    pub mid: Vec<f64>,
    pub side: Vec<f64>,
    pub mono: bool,
}

impl MidSide {
    /// Combined (mid + side) energy per grid point, dB: the same shape as `SpectrumReport::level`.
    pub fn total(&self) -> Vec<f64> {
        self.mid
            .iter()
            .zip(&self.side)
            .map(|(m, s)| db(10f64.powf(m / 10.0) + 10f64.powf(s / 10.0)).max(FLOOR_DB))
            .collect()
    }
}

/// Mid and side spectra of a range for EQ matching; `loudest` restricts them to its loudest parts.
pub fn mid_side(audio: &AudioData, start: usize, end: usize, loudest: bool) -> Option<MidSide> {
    let psd = average_psd(audio, start, end, loudest)?;
    let on_grid = |p: &[f64]| -> Vec<f64> {
        grid()
            .iter()
            .map(|&f| {
                let (lo, hi) = smoothing_band(f);
                db(band_energy(p, psd.bin_hz, lo, hi)).max(FLOOR_DB)
            })
            .collect()
    };
    Some(MidSide { mid: on_grid(&psd.mid), side: on_grid(&psd.side), mono: audio.channels.len() == 1 })
}

/// Piece length in samples, and per piece whether it is one of the loudest.
fn loudest_pieces(left: &[f32], right: &[f32], sample_rate: u32) -> (usize, Vec<bool>) {
    let len = left.len();
    let max_piece = (LOUDEST_PIECE_SECONDS * sample_rate as f64) as usize;
    let pieces = len / max_piece.max(1) + 1;
    let size = (len / pieces).max(1);
    let powers: Vec<f64> = (0..pieces)
        .map(|p| {
            let (s, e) = (p * size, ((p + 1) * size).min(len));
            let sum: f64 = left[s..e].iter().zip(&right[s..e]).map(|(&l, &r)| ((l + r) as f64 * 0.5).powi(2)).sum();
            sum / (e - s).max(1) as f64
        })
        .collect();
    let mean = powers.iter().sum::<f64>() / pieces as f64;
    (size, powers.iter().map(|&p| p >= mean).collect())
}

fn width_db(mid: f64, side: f64) -> Option<f64> {
    // Below this the band is effectively empty and the ratio is noise.
    const MIN_ENERGY: f64 = 1e-20;
    if mid + side < MIN_ENERGY {
        return None;
    }
    let w = db(side.max(MIN_ENERGY)) - db(mid.max(MIN_ENERGY));
    Some(w.max(-60.0))
}

fn smoothing_band(f: f64) -> (f64, f64) {
    let half = 2f64.powf(SMOOTHING_OCTAVES / 2.0);
    (f / half, f * half)
}

/// Energy in [lo, hi) Hz: mean PSD over the band times its width in bins. Where the band is
/// narrower than one bin (low frequencies), the PSD is interpolated at the band centre.
fn band_energy(psd: &[f64], bin_hz: f64, lo: f64, hi: f64) -> f64 {
    let nyquist = (psd.len() - 1) as f64 * bin_hz;
    let hi = hi.min(nyquist);
    if hi <= lo {
        return 0.0;
    }
    let first = (lo / bin_hz).ceil() as usize;
    let last = ((hi / bin_hz).ceil() as usize).min(psd.len());
    let mean = if last > first {
        psd[first..last].iter().sum::<f64>() / (last - first) as f64
    } else {
        let pos = (lo + hi) / 2.0 / bin_hz;
        let i = (pos.floor() as usize).min(psd.len() - 2);
        let t = pos - i as f64;
        psd[i] * (1.0 - t) + psd[i + 1] * t
    };
    mean * (hi - lo) / bin_hz
}

fn centroid(total: &[f64], bin_hz: f64) -> Option<f64> {
    let (mut num, mut den) = (0.0, 0.0);
    for (i, &p) in total.iter().enumerate() {
        let f = i as f64 * bin_hz;
        if (GRID_MIN_HZ..=GRID_MAX_HZ).contains(&f) {
            num += f * p;
            den += p;
        }
    }
    (den > 0.0).then(|| num / den)
}

/// Least-squares slope of level (dB) against log2(f), dB per octave.
fn tilt(freqs: &[f64], level: &[f32]) -> Option<f64> {
    let pts: Vec<(f64, f64)> = freqs
        .iter()
        .zip(level)
        .filter(|(f, l)| (TILT_RANGE_HZ.0..=TILT_RANGE_HZ.1).contains(*f) && (**l as f64) > FLOOR_DB)
        .map(|(f, l)| (f.log2(), *l as f64))
        .collect();
    if pts.len() < 2 {
        return None;
    }
    let n = pts.len() as f64;
    let mx = pts.iter().map(|p| p.0).sum::<f64>() / n;
    let my = pts.iter().map(|p| p.1).sum::<f64>() / n;
    let sxy: f64 = pts.iter().map(|(x, y)| (x - mx) * (y - my)).sum();
    let sxx: f64 = pts.iter().map(|(x, _)| (x - mx).powi(2)).sum();
    (sxx > 0.0).then(|| sxy / sxx)
}

/// Welch-averaged mid and side power spectra over the gated frames of the range; with `loudest`,
/// only frames centred in the loudest pieces (`loudest_pieces`) count.
fn average_psd(audio: &AudioData, start: usize, end: usize, loudest: bool) -> Option<Psd> {
    let end = end.min(audio.frames());
    let start = start.min(end);
    let left = &audio.channels[0][start..end];
    let right = &audio.channels.get(1).unwrap_or(&audio.channels[0])[start..end];
    let mono = audio.channels.len() == 1;

    // Ranges shorter than one FFT are zero-padded into a single frame.
    let frame_starts: Vec<usize> = if left.len() <= FFT_SIZE {
        vec![0]
    } else {
        (0..=(left.len() - FFT_SIZE)).step_by(HOP).collect()
    };
    let frame_len = |s: usize| (left.len() - s).min(FFT_SIZE);

    // Pass 1: frame levels for gating.
    let levels: Vec<f64> = frame_starts
        .iter()
        .map(|&s| {
            let n = frame_len(s);
            let e: f64 = left[s..s + n]
                .iter()
                .zip(&right[s..s + n])
                .map(|(&l, &r)| (l as f64).powi(2) + (r as f64).powi(2))
                .sum();
            e / (2 * n.max(1)) as f64
        })
        .collect();
    let mean = levels.iter().sum::<f64>() / levels.len() as f64;
    if mean <= 0.0 {
        return None;
    }
    let gate = mean * 10f64.powf(FRAME_GATE_DB / 10.0);
    let in_loudest = loudest.then(|| loudest_pieces(left, right, audio.sample_rate));

    // Pass 2: FFT the frames that pass the gate.
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let window: Vec<f32> = (0..FFT_SIZE)
        .map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / FFT_SIZE as f64).cos()) as f32)
        .collect();
    let (mut in_l, mut in_r) = (fft.make_input_vec(), fft.make_input_vec());
    let (mut out_l, mut out_r) = (fft.make_output_vec(), fft.make_output_vec());
    let bins = out_l.len();
    let mut mid = vec![0.0f64; bins];
    let mut side = vec![0.0f64; bins];
    let mut frames = 0usize;

    for (&s, &level) in frame_starts.iter().zip(&levels) {
        if level < gate {
            continue;
        }
        if let Some((size, keep)) = &in_loudest {
            if !keep[((s + frame_len(s) / 2) / size).min(keep.len() - 1)] {
                continue;
            }
        }
        let n = frame_len(s);
        in_l.fill(0.0);
        in_r.fill(0.0);
        for i in 0..n {
            in_l[i] = left[s + i] * window[i];
            in_r[i] = right[s + i] * window[i];
        }
        fft.process(&mut in_l, &mut out_l).ok()?;
        if mono {
            out_r.copy_from_slice(&out_l);
        } else {
            fft.process(&mut in_r, &mut out_r).ok()?;
        }
        for k in 0..bins {
            // M = (L+R)/2, S = (L−R)/2, so |M|² + |S|² = (|L|² + |R|²)/2: the per-channel mean.
            let m = (out_l[k] + out_r[k]) * 0.5;
            let d = (out_l[k] - out_r[k]) * 0.5;
            mid[k] += m.norm_sqr() as f64;
            side[k] += d.norm_sqr() as f64;
        }
        frames += 1;
    }
    if frames == 0 {
        return None;
    }
    // Scale so that summing bins gives mean-square power (one-sided spectrum, Hann window),
    // which keeps levels comparable across sample rates.
    let window_power: f64 = window.iter().map(|&w| (w as f64).powi(2)).sum();
    let scale = 2.0 / (FFT_SIZE as f64 * window_power * frames as f64);
    for v in mid.iter_mut().chain(side.iter_mut()) {
        *v *= scale;
    }
    Some(Psd { mid, side, bin_hz: audio.sample_rate as f64 / FFT_SIZE as f64 })
}
