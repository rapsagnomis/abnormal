//! Dynamics: how much level moves, at micro (transients, ms) and macro (sections, s) scales.

use serde::Serialize;

use crate::decode::AudioData;
use crate::loudness::{Blocks, Curve, HOP_SECONDS};

/// Short-term loudness is a 3 s window = 30 blocks.
const SHORT_TERM_BLOCKS: usize = 30;
/// BS.1770 / EBU 3342 gates applied to short-term values for PSR, percentiles and the histogram.
const ABSOLUTE_GATE_LUFS: f64 = -70.0;
const RELATIVE_GATE_LU: f64 = -20.0;

/// Short-window crest factor (micro dynamics): 50 ms windows.
const CREST_WINDOW_SECONDS: f64 = 0.05;
/// Windows this far below the average window level are ignored (fades, gaps, tails).
const CREST_RELATIVE_GATE_DB: f64 = -20.0;

/// TT DR / foobar2000 "DR Meter" algorithm parameters.
const DR_BLOCK_SECONDS: f64 = 3.0;
const DR_TOP_FRACTION: f64 = 0.2;

/// Onset detection on a 10 ms energy envelope.
const ONSET_FRAME_SECONDS: f64 = 0.01;
/// How far back to look for the pre-attack level.
const ONSET_LOOKBACK_FRAMES: usize = 3;
/// Minimum level rise over the lookback to count as an onset.
const ONSET_MIN_RISE_DB: f64 = 6.0;
/// Minimum time between onsets; within it only the strongest rise counts.
const ONSET_REFRACTORY_SECONDS: f64 = 0.05;
/// Frames quieter than this relative to the loudest frames are ignored.
const ONSET_GATE_DB: f64 = -30.0;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DynamicsStats {
    /// Peak / RMS over the whole range, dB.
    pub crest: Option<f64>,
    /// Median of the gated 50 ms crest factors, dB.
    pub crest_short_median: Option<f64>,
    /// Peak-to-short-term-loudness ratio (true peak in 3 s − short-term loudness), LU.
    pub psr_median: Option<f64>,
    pub psr_min: Option<f64>,
    /// TT DR score (unrounded; the UI shows it as "DRn").
    pub dr: Option<f64>,
    /// Detected onsets per second over the range.
    pub onset_rate: Option<f64>,
    /// Mean level rise at onsets, dB — how hard transients jump out of what precedes them.
    pub onset_rise: Option<f64>,
    /// Gated short-term loudness percentiles, LUFS.
    pub short_term_p10: Option<f64>,
    pub short_term_p50: Option<f64>,
    pub short_term_p95: Option<f64>,
}

/// Fraction of time per bin: bin `i` covers `[min + i*step, min + (i+1)*step)`.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Histogram {
    pub min: f64,
    pub step: f64,
    pub fractions: Vec<f64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DynamicsReport {
    pub stats: DynamicsStats,
    pub short_term_histogram: Histogram,
    pub crest_histogram: Histogram,
    /// PSR over time (only when curves are requested).
    pub psr: Option<Curve>,
}

fn db(linear: f64) -> f64 {
    20.0 * linear.log10()
}

fn finite(v: f64) -> Option<f64> {
    v.is_finite().then_some(v)
}

/// Linear-interpolated percentile of a sorted slice, `p` in 0..=1.
fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let pos = p * (sorted.len() - 1) as f64;
    let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
    Some(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo as f64))
}

fn sorted(mut v: Vec<f64>) -> Vec<f64> {
    v.sort_by(f64::total_cmp);
    v
}

fn histogram(values: &[f64], min: f64, max: f64, step: f64) -> Histogram {
    let bins = ((max - min) / step).round() as usize;
    let mut counts = vec![0usize; bins];
    for &v in values {
        let i = ((v - min) / step).floor().clamp(0.0, (bins - 1) as f64) as usize;
        counts[i] += 1;
    }
    let total = values.len().max(1) as f64;
    Histogram { min, step, fractions: counts.into_iter().map(|c| c as f64 / total).collect() }
}

/// Indices of short-term blocks passing the absolute and relative gates (as for LRA).
fn gated_short_term(blocks: &Blocks) -> Vec<usize> {
    let above_abs: Vec<usize> = (0..blocks.short_term.len())
        .filter(|&i| blocks.short_term[i] > ABSOLUTE_GATE_LUFS)
        .collect();
    if above_abs.is_empty() {
        return above_abs;
    }
    let mean_power = above_abs.iter().map(|&i| 10f64.powf(blocks.short_term[i] / 10.0)).sum::<f64>()
        / above_abs.len() as f64;
    let gate = 10.0 * mean_power.log10() + RELATIVE_GATE_LU;
    above_abs.into_iter().filter(|&i| blocks.short_term[i] > gate).collect()
}

pub fn analyze(
    audio: &AudioData,
    start: usize,
    end: usize,
    blocks: &Blocks,
    range_start_seconds: f64,
    with_curves: bool,
) -> DynamicsReport {
    let end = end.min(audio.frames());
    let start = start.min(end);
    let rate = audio.sample_rate as f64;
    let channels: Vec<&[f32]> = audio.channels.iter().map(|c| &c[start..end]).collect();

    // ── Macro: gated short-term distribution ──
    let gated = gated_short_term(blocks);
    let st_values = sorted(gated.iter().map(|&i| blocks.short_term[i]).collect());

    // ── PSR: true peak over the same 3 s window as each short-term reading ──
    let psr_at = |i: usize| -> f64 {
        let from = (i + 1).saturating_sub(SHORT_TERM_BLOCKS);
        let tp = blocks.true_peak[from..=i].iter().cloned().fold(0.0, f64::max);
        db(tp) - blocks.short_term[i]
    };
    let psr_values = sorted(gated.iter().map(|&i| psr_at(i)).filter(|v| v.is_finite()).collect());
    // Blocks outside the gate (silence, fades, quiet intros) are NaN, serialised as null, so the
    // curve shows gaps there instead of meaningless spikes.
    let mut in_gate = vec![false; blocks.short_term.len()];
    for &i in &gated {
        in_gate[i] = true;
    }
    let psr = with_curves.then(|| Curve {
        t0: range_start_seconds + SHORT_TERM_BLOCKS as f64 * HOP_SECONDS / 2.0,
        hop: HOP_SECONDS,
        values: (SHORT_TERM_BLOCKS - 1..blocks.short_term.len())
            .map(|i| if in_gate[i] { psr_at(i) as f32 } else { f32::NAN })
            .collect(),
    });

    // ── Micro: crest factors ──
    let crest = whole_range_crest(&channels);
    let crest_short = short_window_crests(&channels, (CREST_WINDOW_SECONDS * rate) as usize);
    let crest_sorted = sorted(crest_short.clone());

    let (onset_rate, onset_rise) = onsets(&channels, rate);

    DynamicsReport {
        stats: DynamicsStats {
            crest,
            crest_short_median: percentile(&crest_sorted, 0.5),
            psr_median: percentile(&psr_values, 0.5),
            psr_min: psr_values.first().copied(),
            dr: dr_score(&channels, rate),
            onset_rate,
            onset_rise,
            short_term_p10: percentile(&st_values, 0.1),
            short_term_p50: percentile(&st_values, 0.5),
            short_term_p95: percentile(&st_values, 0.95),
        },
        short_term_histogram: histogram(&st_values, -60.0, 0.0, 1.0),
        crest_histogram: histogram(&crest_short, 0.0, 30.0, 0.5),
        psr,
    }
}

fn whole_range_crest(channels: &[&[f32]]) -> Option<f64> {
    let (mut peak, mut sum_sq, mut n) = (0.0f64, 0.0f64, 0usize);
    for ch in channels {
        for &s in *ch {
            let s = s as f64;
            peak = peak.max(s.abs());
            sum_sq += s * s;
        }
        n += ch.len();
    }
    if n == 0 || sum_sq == 0.0 {
        return None;
    }
    finite(db(peak / (sum_sq / n as f64).sqrt()))
}

/// Crest factor of each non-overlapping window, keeping only windows near the programme level.
fn short_window_crests(channels: &[&[f32]], window: usize) -> Vec<f64> {
    let len = channels.first().map_or(0, |c| c.len());
    if window == 0 || len < window {
        return Vec::new();
    }
    let mut windows = Vec::with_capacity(len / window);
    for w in 0..len / window {
        let (mut peak, mut sum_sq) = (0.0f64, 0.0f64);
        for ch in channels {
            for &s in &ch[w * window..(w + 1) * window] {
                let s = s as f64;
                peak = peak.max(s.abs());
                sum_sq += s * s;
            }
        }
        let rms = (sum_sq / (window * channels.len()) as f64).sqrt();
        if rms > 0.0 {
            windows.push((db(rms), db(peak / rms)));
        }
    }
    if windows.is_empty() {
        return Vec::new();
    }
    let mean_power = windows.iter().map(|(l, _)| 10f64.powf(l / 10.0)).sum::<f64>() / windows.len() as f64;
    let gate = 10.0 * mean_power.log10() + CREST_RELATIVE_GATE_DB;
    windows.into_iter().filter(|(l, _)| *l > gate).map(|(_, c)| c).collect()
}

/// TT DR: per channel, 3 s blocks; DR = second-highest block peak over the RMS of the loudest
/// 20 % of blocks (block RMS scaled by √2 so a full-scale sine reads 0). Averaged over channels.
fn dr_score(channels: &[&[f32]], rate: f64) -> Option<f64> {
    let block = (DR_BLOCK_SECONDS * rate) as usize;
    let mut per_channel = Vec::new();
    for ch in channels {
        let mut rms = Vec::new();
        let mut peaks = Vec::new();
        for chunk in ch.chunks(block) {
            // A short trailing block would skew the statistics; keep it only if it is the only one.
            if chunk.len() < block / 2 && !rms.is_empty() {
                continue;
            }
            let sum_sq: f64 = chunk.iter().map(|&s| (s as f64) * (s as f64)).sum();
            rms.push((2.0 * sum_sq / chunk.len() as f64).sqrt());
            peaks.push(chunk.iter().fold(0.0f64, |m, &s| m.max((s as f64).abs())));
        }
        if rms.is_empty() {
            continue;
        }
        rms.sort_by(|a, b| b.total_cmp(a));
        peaks.sort_by(|a, b| b.total_cmp(a));
        let top = ((rms.len() as f64 * DR_TOP_FRACTION).round() as usize).max(1);
        let rms_top = (rms[..top].iter().map(|r| r * r).sum::<f64>() / top as f64).sqrt();
        let peak = if peaks.len() > 1 { peaks[1] } else { peaks[0] };
        if rms_top > 0.0 && peak > 0.0 {
            per_channel.push(db(peak / rms_top));
        }
    }
    if per_channel.is_empty() {
        None
    } else {
        Some(per_channel.iter().sum::<f64>() / per_channel.len() as f64)
    }
}

/// Energy-envelope onset detection. Returns (onsets per second, mean rise in dB).
fn onsets(channels: &[&[f32]], rate: f64) -> (Option<f64>, Option<f64>) {
    let frame = ((ONSET_FRAME_SECONDS * rate) as usize).max(1);
    let len = channels.first().map_or(0, |c| c.len());
    let n_frames = len / frame;
    if n_frames <= ONSET_LOOKBACK_FRAMES {
        return (None, None);
    }

    let levels: Vec<f64> = (0..n_frames)
        .map(|f| {
            let sum_sq: f64 = channels
                .iter()
                .flat_map(|ch| &ch[f * frame..(f + 1) * frame])
                .map(|&s| (s as f64) * (s as f64))
                .sum();
            10.0 * (sum_sq / (frame * channels.len()) as f64).max(1e-12).log10()
        })
        .collect();

    // Gate relative to the loud end of the programme so quiet passages don't count.
    let loud = percentile(&sorted(levels.clone()), 0.95).unwrap_or(f64::NEG_INFINITY);
    let gate = loud + ONSET_GATE_DB;
    let refractory = (ONSET_REFRACTORY_SECONDS / ONSET_FRAME_SECONDS).round() as usize;

    let mut rises: Vec<f64> = Vec::new();
    let mut last_onset: Option<usize> = None;
    for i in ONSET_LOOKBACK_FRAMES..n_frames {
        if levels[i] < gate {
            continue;
        }
        // Floor the pre-attack level at the gate, so a hit out of silence counts as a rise from
        // the gate rather than from digital silence (which would read as ~100 dB).
        let before = levels[i - ONSET_LOOKBACK_FRAMES..i]
            .iter()
            .cloned()
            .fold(f64::INFINITY, f64::min)
            .max(gate);
        let rise = levels[i] - before;
        if rise < ONSET_MIN_RISE_DB {
            continue;
        }
        match last_onset {
            // Same attack: keep the strongest rise.
            Some(prev) if i - prev < refractory => {
                let r = rises.last_mut().unwrap();
                *r = r.max(rise);
            }
            _ => {
                rises.push(rise);
                last_onset = Some(i);
            }
        }
    }

    let seconds = len as f64 / rate;
    let rate_per_s = finite(rises.len() as f64 / seconds);
    let mean_rise = (!rises.is_empty()).then(|| rises.iter().sum::<f64>() / rises.len() as f64);
    (rate_per_s, mean_rise)
}
