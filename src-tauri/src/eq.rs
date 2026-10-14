//! Turn the tonal difference between two tracks into a few concrete EQ moves.
//!
//! The target is the loudness-normalised spectral difference (reference − track), smoothed to
//! 1/3 octave with its broadband offset removed (level is loudness matching's job, not EQ's).
//! Filters are then fitted greedily: each step tries peaking filters at the residual's extrema
//! and low/high shelves, and keeps whichever removes the most perceptually weighted error.
//!
//! `match_eq` adds the mid/side view Matchering uses: after the stereo moves, what is left of the
//! side's difference becomes a broadband side level change (width) and a few side-only moves.
//! It also gives the "full match": Matchering's unconstrained correction (the difference itself,
//! LOWESS-smoothed on a log axis), for mid and side, to compare the moves with and to hear.

use serde::{Deserialize, Serialize};

use crate::spectrum::MidSide;

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

const SIDE_MAX_MOVES: usize = 3;
/// Where A's side is this far below its mid (dB), side EQ hardly changes what you hear; it gets
/// full weight from `SIDE_FULL_DB` up.
const SIDE_SILENT_DB: f64 = -24.0;
const SIDE_FULL_DB: f64 = -6.0;
/// Range whose median side difference is taken as a width change rather than side EQ.
const WIDTH_RANGE_HZ: (f64, f64) = (150.0, 10000.0);
const MIN_WIDTH_DB: f64 = 0.5;
/// A width change is a side high shelf this low: flat across the audible range, and something
/// Pro-Q can hold.
pub const WIDTH_SHELF_HZ: f64 = 10.0;
/// Full match smoothing: Matchering's LOWESS takes 3.75 % of a 10-octave log axis per point.
const FULL_SPAN_OCTAVES: f64 = 0.375;
/// Matchering leaves its curve unbounded; limit it so empty bands aren't boosted into noise.
const FULL_MAX_DB: f64 = 12.0;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FilterKind {
    Peak,
    LowShelf,
    HighShelf,
}

/// Which signal a move acts on: both channels alike, or only the side (L − R).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Placement {
    #[default]
    Stereo,
    Side,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub kind: FilterKind,
    pub freq: f64,
    pub gain: f64,
    pub q: f64,
    #[serde(default)]
    pub placement: Placement,
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

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SideReport {
    /// Broadband side level change (wider or narrower overall), as a side shelf at `WIDTH_SHELF_HZ`.
    pub width: Option<Filter>,
    /// Side-only moves, largest effect first.
    pub suggestions: Vec<Filter>,
    /// What A's side needs (B − A side, smoothed, the same level offset removed), dB per grid point.
    pub target: Vec<Option<f32>>,
    /// Weighted RMS of the side target left after the stereo moves, and after the side moves too.
    pub error_before: f64,
    pub error_after: f64,
}

/// Matchering-style correction: the difference itself, smoothed but not reduced to moves.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FullMatch {
    /// For the combined signal (comparable with `EqReport::target`), mid and side, dB per grid point.
    pub total: Vec<f32>,
    pub mid: Vec<f32>,
    pub side: Vec<f32>,
    /// Weighted RMS difference between the full match and the stereo moves (total), and between
    /// the full side match and all moves' effect on the side, dB.
    pub gap: f64,
    pub side_gap: Option<f64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MatchReport {
    #[serde(flatten)]
    pub stereo: EqReport,
    /// None when either track is mono.
    pub side: Option<SideReport>,
    pub full: FullMatch,
}

/// Biquad coefficients normalised so a0 = 1.
#[derive(Debug, Clone, Copy, Default)]
pub struct Biquad {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

impl Biquad {
    /// Magnitude response at `f` Hz, dB.
    #[cfg(test)]
    pub fn response_db(&self, f: f64, sample_rate: f64) -> f64 {
        use realfft::num_complex::Complex;
        let z = Complex::from_polar(1.0, -2.0 * std::f64::consts::PI * f / sample_rate);
        let num = self.b0 + self.b1 * z + self.b2 * z * z;
        let den = 1.0 + self.a1 * z + self.a2 * z * z;
        20.0 * (num / den).norm().log10()
    }
}

impl Filter {
    pub fn stereo(kind: FilterKind, freq: f64, gain: f64, q: f64) -> Self {
        Self { kind, freq, gain, q, placement: Placement::Stereo }
    }

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

    /// Digital RBJ cookbook coefficients at `sample_rate`, for playing the move back. The corner
    /// is kept below Nyquist, where the bilinear transform would otherwise fold it.
    pub fn biquad(&self, sample_rate: f64) -> Biquad {
        let f = self.freq.min(sample_rate * 0.45);
        let a = 10f64.powf(self.gain / 40.0);
        let (sin, cos) = (2.0 * std::f64::consts::PI * f / sample_rate).sin_cos();
        let alpha = sin / (2.0 * self.q);
        let sa = 2.0 * a.sqrt() * alpha;
        let (b0, b1, b2, a0, a1, a2) = match self.kind {
            FilterKind::Peak => (1.0 + alpha * a, -2.0 * cos, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cos, 1.0 - alpha / a),
            FilterKind::LowShelf => (
                a * ((a + 1.0) - (a - 1.0) * cos + sa),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                a * ((a + 1.0) - (a - 1.0) * cos - sa),
                (a + 1.0) + (a - 1.0) * cos + sa,
                -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                (a + 1.0) + (a - 1.0) * cos - sa,
            ),
            FilterKind::HighShelf => (
                a * ((a + 1.0) + (a - 1.0) * cos + sa),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                a * ((a + 1.0) + (a - 1.0) * cos - sa),
                (a + 1.0) - (a - 1.0) * cos + sa,
                2.0 * ((a - 1.0) - (a + 1.0) * cos),
                (a + 1.0) - (a - 1.0) * cos - sa,
            ),
        };
        Biquad { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
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
/// shared grid `freqs` (dB per 1/6 octave). The app uses `match_eq`; this is its stereo part.
#[cfg(test)]
pub fn suggest(freqs: &[f64], track: &[f32], reference: &[f32]) -> EqReport {
    let widen = |v: &[f32]| v.iter().map(|&x| x as f64).collect::<Vec<f64>>();
    stereo_report(freqs, &widen(track), &widen(reference))
}

fn stereo_report(freqs: &[f64], track: &[f64], reference: &[f64]) -> EqReport {
    let n = freqs.len().min(track.len()).min(reference.len());
    let freqs = &freqs[..n];
    let weights: Vec<f64> = freqs.iter().map(|&f| weight(f)).collect();
    let smooth = smoothed(&(0..n).map(|i| reference[i] - track[i]).collect::<Vec<f64>>());
    let offset = level_offset(freqs, &smooth);
    let target: Vec<f64> = smooth.iter().map(|d| d - offset).collect();

    let fit = fit(freqs, &target, &weights, MAX_MOVES, Placement::Stereo);
    EqReport {
        error_after: error(&fit.residual, &weights),
        error_before: error(&target, &weights),
        offset,
        target: masked(&target, &weights),
        curve: curve_of(freqs, &fit.suggestions).iter().map(|&v| v as f32).collect(),
        suggestions: fit.suggestions,
    }
}

/// EQ match of `track` towards `reference` in mid/side: the stereo moves (as `suggest`), then a
/// width change and side-only moves for what is left of the side's difference, and the full
/// Matchering-style curves.
pub fn match_eq(freqs: &[f64], track: &MidSide, reference: &MidSide) -> MatchReport {
    let n = freqs.len().min(track.mid.len()).min(reference.mid.len());
    let freqs = &freqs[..n];
    let weights: Vec<f64> = freqs.iter().map(|&f| weight(f)).collect();
    let (track_total, reference_total) = (track.total(), reference.total());
    let stereo = stereo_report(freqs, &track_total, &reference_total);
    let offset = stereo.offset;
    let stereo_curve = curve_of(freqs, &stereo.suggestions);

    // Full match: the raw differences, the level offset removed, smoothed as Matchering does.
    let full_of = |a: &[f64], b: &[f64]| -> Vec<f64> {
        let raw: Vec<f64> = (0..n).map(|i| b[i] - a[i] - offset).collect();
        lowess(freqs, &raw, FULL_SPAN_OCTAVES).into_iter().map(|v| v.clamp(-FULL_MAX_DB, FULL_MAX_DB)).collect()
    };
    let full_total = full_of(&track_total, &reference_total);
    let full_mid = full_of(&track.mid, &reference.mid);
    let gap = error(&diff(&full_total, &stereo_curve), &weights);
    let to_f32 = |v: &[f64]| v.iter().map(|&x| x as f32).collect::<Vec<f32>>();

    if track.mono || reference.mono {
        return MatchReport {
            stereo,
            side: None,
            full: FullMatch { total: to_f32(&full_total), side: to_f32(&full_mid), mid: to_f32(&full_mid), gap, side_gap: None },
        };
    }

    // Side EQ only matters where A has a side signal worth hearing.
    let side_weights: Vec<f64> = (0..n)
        .map(|i| {
            let relative = track.side[i] - track.mid[i];
            weight(freqs[i]) * ((relative - SIDE_SILENT_DB) / (SIDE_FULL_DB - SIDE_SILENT_DB)).clamp(0.0, 1.0)
        })
        .collect();
    let side_target: Vec<f64> =
        smoothed(&(0..n).map(|i| reference.side[i] - track.side[i]).collect::<Vec<f64>>()).iter().map(|d| d - offset).collect();
    // What the stereo moves leave for the side to do.
    let left = diff(&side_target, &stereo_curve);

    let mut in_range: Vec<f64> = (0..n)
        .filter(|&i| (WIDTH_RANGE_HZ.0..=WIDTH_RANGE_HZ.1).contains(&freqs[i]) && side_weights[i] >= 0.5)
        .map(|i| left[i])
        .collect();
    in_range.sort_by(f64::total_cmp);
    let width = in_range
        .get(in_range.len() / 2)
        .filter(|g| g.abs() >= MIN_WIDTH_DB)
        .map(|&g| Filter {
            placement: Placement::Side,
            ..Filter::stereo(FilterKind::HighShelf, WIDTH_SHELF_HZ, (g.clamp(-MAX_GAIN_DB, MAX_GAIN_DB) * 2.0).round() / 2.0, SHELF_Q)
        });
    let after_width = diff(&left, &curve_of(freqs, width.as_slice()));
    let side_fit = fit(freqs, &after_width, &side_weights, SIDE_MAX_MOVES, Placement::Side);

    let full_side = full_of(&track.side, &reference.side);
    let side_moves: Vec<Filter> = width.iter().chain(&side_fit.suggestions).copied().collect();
    let side_curve: Vec<f64> = stereo_curve.iter().zip(curve_of(freqs, &side_moves)).map(|(a, b)| a + b).collect();
    let side_gap = error(&diff(&full_side, &side_curve), &side_weights);

    MatchReport {
        side: Some(SideReport {
            width,
            target: masked(&side_target, &side_weights),
            error_before: error(&left, &side_weights),
            error_after: error(&side_fit.residual, &side_weights),
            suggestions: side_fit.suggestions,
        }),
        full: FullMatch { total: to_f32(&full_total), mid: to_f32(&full_mid), side: to_f32(&full_side), gap, side_gap: Some(side_gap) },
        stereo,
    }
}

/// Smooth to 1/3 octave so moves target broad tonal differences, not individual notes.
fn smoothed(raw: &[f64]) -> Vec<f64> {
    let n = raw.len();
    let half = (SMOOTHING_OCTAVES * POINTS_PER_OCTAVE / 2.0).round() as usize;
    (0..n)
        .map(|i| {
            let (lo, hi) = (i.saturating_sub(half), (i + half + 1).min(n));
            raw[lo..hi].iter().sum::<f64>() / (hi - lo) as f64
        })
        .collect()
}

/// Broadband level difference: the median, not the mean, so a shelf or broad bump covering part
/// of the range doesn't leak into the offset (it would leave an unfittable broadband residual
/// and shrink the move).
fn level_offset(freqs: &[f64], smooth: &[f64]) -> f64 {
    let mut in_offset: Vec<f64> = freqs
        .iter()
        .zip(smooth)
        .filter(|(f, _)| (OFFSET_RANGE_HZ.0..=OFFSET_RANGE_HZ.1).contains(*f))
        .map(|(_, &d)| d)
        .collect();
    in_offset.sort_by(f64::total_cmp);
    in_offset.get(in_offset.len() / 2).copied().unwrap_or(0.0)
}

/// Locally linear regression with tricube weights over `span` octaves around each point (LOWESS
/// without robustness iterations, as Matchering runs it).
fn lowess(freqs: &[f64], values: &[f64], span: f64) -> Vec<f64> {
    let x: Vec<f64> = freqs.iter().map(|f| f.log2()).collect();
    let h = span / 2.0;
    (0..x.len())
        .map(|i| {
            let (mut sw, mut sx, mut sy, mut sxx, mut sxy) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for j in 0..x.len() {
                let d = (x[j] - x[i]).abs() / h;
                if d >= 1.0 {
                    continue;
                }
                let w = (1.0 - d.powi(3)).powi(3);
                let dx = x[j] - x[i];
                sw += w;
                sx += w * dx;
                sy += w * values[j];
                sxx += w * dx * dx;
                sxy += w * dx * values[j];
            }
            // Intercept of the weighted line through the neighbours, at x[i].
            let det = sw * sxx - sx * sx;
            if det.abs() > 1e-12 { (sy * sxx - sx * sxy) / det } else { sy / sw }
        })
        .collect()
}

fn diff(a: &[f64], b: &[f64]) -> Vec<f64> {
    a.iter().zip(b).map(|(x, y)| x - y).collect()
}

/// Combined response of `filters` at each of `freqs`, dB.
fn curve_of(freqs: &[f64], filters: &[Filter]) -> Vec<f64> {
    freqs.iter().map(|&hz| filters.iter().map(|f| f.response_db(hz)).sum()).collect()
}

/// `values` where they count (`weights` > 0), for display.
fn masked(values: &[f64], weights: &[f64]) -> Vec<Option<f32>> {
    values.iter().zip(weights).map(|(&v, &w)| (w > 0.0).then_some(v as f32)).collect()
}

/// Weighted RMS of `residual`, dB.
fn error(residual: &[f64], weights: &[f64]) -> f64 {
    let (num, den) = residual
        .iter()
        .zip(weights)
        .fold((0.0, 0.0), |(n, d), (r, w)| (n + w * r * r, d + w));
    if den > 0.0 { (num / den).sqrt() } else { 0.0 }
}

struct Fit {
    suggestions: Vec<Filter>,
    residual: Vec<f64>,
}

/// Greedily fit up to `max_moves` filters to `target`, each the candidate that removes the most
/// weighted error, until the next would remove too little.
fn fit(freqs: &[f64], target: &[f64], weights: &[f64], max_moves: usize, placement: Placement) -> Fit {
    let error_before = error(target, weights);
    let mut residual = target.to_vec();
    let mut suggestions: Vec<Filter> = Vec::new();
    for _ in 0..max_moves {
        let current = error(&residual, weights);
        let mut best: Option<(f64, Filter)> = None;
        let mut consider = |f: Filter| {
            if f.gain.abs() < MIN_GAIN_DB {
                return;
            }
            let f = Filter { placement, ..f.rounded() };
            let after: Vec<f64> = residual.iter().zip(freqs).map(|(r, &hz)| r - f.response_db(hz)).collect();
            let e = error(&after, weights);
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
    Fit { suggestions, residual }
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
                out.push(Filter::stereo(FilterKind::Peak, freqs[i], r * scale, q));
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
            out.push(Filter::stereo(FilterKind::LowShelf, f, g, SHELF_Q));
        }
        if (HIGH_SHELF_RANGE_HZ.0..=HIGH_SHELF_RANGE_HZ.1).contains(&f) {
            let g = mean(i..n);
            out.push(Filter::stereo(FilterKind::HighShelf, f, g, SHELF_Q));
        }
    }
    out
}
