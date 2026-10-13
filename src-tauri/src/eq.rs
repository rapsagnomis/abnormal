//! Turn the tonal difference between two tracks into a few concrete EQ moves.
//!
//! The target is the loudness-normalised spectral difference (reference − track), smoothed to
//! 1/3 octave with its broadband offset removed (level is loudness matching's job, not EQ's).
//! Filters are then fitted greedily: each step tries peaking filters at the residual's extrema
//! and low/high shelves, and keeps whichever removes the most perceptually weighted error.

use serde::Serialize;

/// Points per octave of the spectrum grid (see `spectrum::grid`).
const POINTS_PER_OCTAVE: f64 = 24.0;
/// Extra smoothing applied to the difference before fitting, in octaves.
const SMOOTHING_OCTAVES: f64 = 1.0 / 3.0;
/// Range whose median difference is treated as a level offset, not EQ.
const OFFSET_RANGE_HZ: (f64, f64) = (100.0, 10000.0);
/// Only fit within this range; outside it the difference is mostly noise or inaudible.
const FIT_RANGE_HZ: (f64, f64) = (25.0, 18000.0);

const MAX_MOVES: usize = 6;
/// Don't suggest moves smaller than this, dB.
const MIN_GAIN_DB: f64 = 0.75;
const MAX_GAIN_DB: f64 = 6.0;
/// Stop when the best candidate removes less than this share of the original error.
const MIN_IMPROVEMENT: f64 = 0.03;
/// Peak widths tried. Narrow peaks would chase individual notes rather than tonal balance, and
/// below `NARROW_LIMIT_HZ` they are limited further because bass notes dominate there.
const PEAK_QS: [f64; 5] = [0.5, 0.7, 1.0, 1.4, 2.0];
const NARROW_LIMIT_HZ: f64 = 150.0;
const LOW_MAX_Q: f64 = 1.0;
/// Two peaks closer than this (octaves) would be stacking one move; only one is allowed.
const MIN_PEAK_SPACING_OCTAVES: f64 = 0.5;
const SHELF_Q: f64 = std::f64::consts::FRAC_1_SQRT_2;
const LOW_SHELF_RANGE_HZ: (f64, f64) = (40.0, 400.0);
const HIGH_SHELF_RANGE_HZ: (f64, f64) = (2000.0, 12000.0);

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FilterKind {
    Peak,
    LowShelf,
    HighShelf,
}

#[derive(Serialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub kind: FilterKind,
    pub freq: f64,
    pub gain: f64,
    pub q: f64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EqReport {
    /// Moves to apply to the track, largest effect first.
    pub suggestions: Vec<Filter>,
    /// What the track needs (reference − track, smoothed, offset removed), dB per grid point.
    pub target: Vec<Option<f32>>,
    /// Combined response of the suggestions, dB per grid point.
    pub curve: Vec<f32>,
    /// Broadband level difference removed from the target, dB.
    pub offset: f64,
    /// Weighted RMS of the target before and after applying the suggestions, dB.
    pub error_before: f64,
    pub error_after: f64,
}

impl Filter {
    /// Magnitude response in dB at `f`, using the analog prototypes of the RBJ cookbook filters
    /// (independent of sample rate, accurate well below Nyquist).
    pub fn response_db(&self, f: f64) -> f64 {
        let a = 10f64.powf(self.gain / 40.0);
        let w = f / self.freq;
        let w2 = w * w;
        let q = self.q;
        let mag2 = match self.kind {
            FilterKind::Peak => {
                ((1.0 - w2).powi(2) + (w * a / q).powi(2)) / ((1.0 - w2).powi(2) + (w / (a * q)).powi(2))
            }
            FilterKind::LowShelf => {
                let k = w2 * a / (q * q);
                a * a * ((a - w2).powi(2) + k) / ((1.0 - a * w2).powi(2) + k)
            }
            FilterKind::HighShelf => {
                let k = w2 * a / (q * q);
                a * a * ((1.0 - a * w2).powi(2) + k) / ((a - w2).powi(2) + k)
            }
        };
        10.0 * mag2.log10()
    }

    /// Round to values you would actually dial in.
    fn rounded(self) -> Self {
        let freq = match self.freq {
            f if f < 100.0 => f.round(),
            f if f < 1000.0 => (f / 5.0).round() * 5.0,
            f if f < 10000.0 => (f / 50.0).round() * 50.0,
            f => (f / 500.0).round() * 500.0,
        };
        Self {
            freq,
            gain: (self.gain.clamp(-MAX_GAIN_DB, MAX_GAIN_DB) * 2.0).round() / 2.0,
            q: (self.q * 10.0).round() / 10.0,
            ..self
        }
    }
}

/// Perceptual weight of each frequency in the fit: full weight across the musical range, less at
/// the extremes where the difference is less audible and less reliable.
fn weight(f: f64) -> f64 {
    match f {
        f if f < FIT_RANGE_HZ.0 || f > FIT_RANGE_HZ.1 => 0.0,
        f if f < 40.0 => 0.1,
        f if f < 60.0 => 0.4,
        f if f > 12000.0 => 0.5,
        _ => 1.0,
    }
}

/// Suggest EQ for `track` to approach `reference`. Both are loudness-normalised spectra on the
/// shared grid `freqs` (dB per 1/6 octave).
pub fn suggest(freqs: &[f64], track: &[f32], reference: &[f32]) -> EqReport {
    let n = freqs.len().min(track.len()).min(reference.len());
    let freqs = &freqs[..n];
    let weights: Vec<f64> = freqs.iter().map(|&f| weight(f)).collect();
    let raw: Vec<f64> = (0..n).map(|i| (reference[i] - track[i]) as f64).collect();

    // Smooth to 1/3 octave so moves target broad tonal differences, not individual notes.
    let half = (SMOOTHING_OCTAVES * POINTS_PER_OCTAVE / 2.0).round() as usize;
    let smooth: Vec<f64> = (0..n)
        .map(|i| {
            let (lo, hi) = (i.saturating_sub(half), (i + half + 1).min(n));
            raw[lo..hi].iter().sum::<f64>() / (hi - lo) as f64
        })
        .collect();

    // Median rather than mean: a shelf or broad bump covering part of the range must not leak
    // into the offset (it would leave an unfittable broadband residual and shrink the move).
    let mut in_offset: Vec<f64> = freqs
        .iter()
        .zip(&smooth)
        .filter(|(f, _)| (OFFSET_RANGE_HZ.0..=OFFSET_RANGE_HZ.1).contains(*f))
        .map(|(_, &d)| d)
        .collect();
    in_offset.sort_by(f64::total_cmp);
    let offset = in_offset.get(in_offset.len() / 2).copied().unwrap_or(0.0);
    let target: Vec<f64> = smooth.iter().map(|d| d - offset).collect();

    let error = |residual: &[f64]| -> f64 {
        let (num, den) = residual
            .iter()
            .zip(&weights)
            .fold((0.0, 0.0), |(n, d), (r, w)| (n + w * r * r, d + w));
        if den > 0.0 { (num / den).sqrt() } else { 0.0 }
    };
    let error_before = error(&target);

    let mut residual = target.clone();
    let mut suggestions: Vec<Filter> = Vec::new();
    for _ in 0..MAX_MOVES {
        let current = error(&residual);
        let mut best: Option<(f64, Filter)> = None;
        let mut consider = |f: Filter| {
            if f.gain.abs() < MIN_GAIN_DB {
                return;
            }
            let f = f.rounded();
            let after: Vec<f64> = residual.iter().zip(freqs).map(|(r, &hz)| r - f.response_db(hz)).collect();
            let e = error(&after);
            if best.is_none_or(|(b, _)| e < b) {
                best = Some((e, f));
            }
        };

        for c in candidates(freqs, &residual) {
            if !conflicts(&c, &suggestions) {
                consider(c);
            }
        }

        let Some((e, filter)) = best else { break };
        if current - e < MIN_IMPROVEMENT * error_before || current - e <= 0.0 {
            break;
        }
        for (r, &hz) in residual.iter_mut().zip(freqs) {
            *r -= filter.response_db(hz);
        }
        suggestions.push(filter);
    }

    let curve: Vec<f32> = freqs
        .iter()
        .map(|&hz| suggestions.iter().map(|f| f.response_db(hz)).sum::<f64>() as f32)
        .collect();
    EqReport {
        error_after: error(&residual),
        error_before,
        offset,
        target: target
            .iter()
            .zip(&weights)
            .map(|(&t, &w)| (w > 0.0).then_some(t as f32))
            .collect(),
        curve,
        suggestions,
    }
}

/// A candidate conflicts with an existing move if it is a second shelf of the same kind, or a peak
/// within `MIN_PEAK_SPACING_OCTAVES` of an existing peak.
fn conflicts(c: &Filter, existing: &[Filter]) -> bool {
    existing.iter().any(|e| match (c.kind, e.kind) {
        (FilterKind::Peak, FilterKind::Peak) => (c.freq / e.freq).log2().abs() < MIN_PEAK_SPACING_OCTAVES,
        (a, b) => a == b && a != FilterKind::Peak,
    })
}

/// Candidate filters for the current residual: peaks at each local extremum (several widths and
/// gains), and shelves at a range of corner frequencies using the mean residual beyond them.
fn candidates(freqs: &[f64], residual: &[f64]) -> Vec<Filter> {
    let n = freqs.len();
    let mut out = Vec::new();
    let in_fit = |f: f64| (FIT_RANGE_HZ.0..=FIT_RANGE_HZ.1).contains(&f);

    for i in 1..n.saturating_sub(1) {
        let r = residual[i];
        let extremum = (r > residual[i - 1] && r >= residual[i + 1]) || (r < residual[i - 1] && r <= residual[i + 1]);
        if !extremum || !in_fit(freqs[i]) || r.abs() < MIN_GAIN_DB {
            continue;
        }
        for q in PEAK_QS.into_iter().filter(|&q| freqs[i] >= NARROW_LIMIT_HZ || q <= LOW_MAX_Q) {
            for scale in [0.6, 0.8, 1.0] {
                out.push(Filter { kind: FilterKind::Peak, freq: freqs[i], gain: r * scale, q });
            }
        }
    }

    let mean = |range: std::ops::Range<usize>| -> f64 {
        let vals: Vec<f64> = range.filter(|&i| in_fit(freqs[i])).map(|i| residual[i]).collect();
        if vals.is_empty() { 0.0 } else { vals.iter().sum::<f64>() / vals.len() as f64 }
    };
    for (i, &f) in freqs.iter().enumerate() {
        if (LOW_SHELF_RANGE_HZ.0..=LOW_SHELF_RANGE_HZ.1).contains(&f) {
            let g = mean(0..i + 1);
            out.push(Filter { kind: FilterKind::LowShelf, freq: f, gain: g, q: SHELF_Q });
        }
        if (HIGH_SHELF_RANGE_HZ.0..=HIGH_SHELF_RANGE_HZ.1).contains(&f) {
            let g = mean(i..n);
            out.push(Filter { kind: FilterKind::HighShelf, freq: f, gain: g, q: SHELF_Q });
        }
    }
    out
}
