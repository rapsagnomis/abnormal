//! Stereo image in the time domain: phase correlation, mid/side balance and a goniometer.

use serde::Serialize;

use crate::decode::AudioData;
use crate::loudness::{Curve, HOP_SECONDS};

/// Correlation is measured over 400 ms windows (the momentary-loudness window), every 100 ms.
const CORRELATION_WINDOW_SECONDS: f64 = 0.4;
/// Windows this far below the average window level are ignored.
const WINDOW_GATE_DB: f64 = -20.0;

/// Goniometer resolution (cells per side) and point budget.
pub const GONIO_SIZE: usize = 64;
const GONIO_MAX_POINTS: usize = 400_000;
/// Scale the goniometer so this quantile of sample radii sits at the edge.
const GONIO_SCALE_QUANTILE: f64 = 0.995;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StereoStats {
    pub mono: bool,
    /// Phase correlation over the gated range, −1…+1.
    pub correlation: Option<f64>,
    /// 5th percentile of 400 ms window correlations: the least mono-compatible moments.
    pub correlation_p5: Option<f64>,
    /// Fraction of gated windows with negative correlation.
    pub negative_fraction: Option<f64>,
    /// Side − mid energy, dB.
    pub side_to_mid: Option<f64>,
    /// Left − right energy, dB (positive = leans left).
    pub balance: Option<f64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StereoReport {
    pub stats: StereoStats,
    /// Density of (side, mid) sample positions, row-major from the top (mid = +1) and left
    /// (side = −1), normalised so the densest cell is 1.
    pub goniometer: Vec<f32>,
    pub goniometer_size: usize,
    /// Correlation over time (only when curves are requested); null where gated out.
    pub correlation: Option<Curve>,
}

pub fn analyze(audio: &AudioData, start: usize, end: usize, range_start_seconds: f64, with_curves: bool) -> StereoReport {
    let end = end.min(audio.frames());
    let start = start.min(end);
    let left = &audio.channels[0][start..end];
    let mono = audio.channels.len() == 1;
    let right = if mono { left } else { &audio.channels[1][start..end] };
    let rate = audio.sample_rate as f64;

    // ── Windowed correlation ──
    let hop = (HOP_SECONDS * rate).round() as usize;
    let window = (CORRELATION_WINDOW_SECONDS * rate).round() as usize;
    struct Win {
        energy: f64,
        corr: f64,
    }
    let mut windows: Vec<Win> = Vec::new();
    let mut s = 0;
    while hop > 0 && s + window <= left.len() {
        let (mut lr, mut ll, mut rr) = (0.0f64, 0.0f64, 0.0f64);
        for (&l, &r) in left[s..s + window].iter().zip(&right[s..s + window]) {
            let (l, r) = (l as f64, r as f64);
            lr += l * r;
            ll += l * l;
            rr += r * r;
        }
        let corr = if ll > 0.0 && rr > 0.0 { lr / (ll * rr).sqrt() } else { f64::NAN };
        windows.push(Win { energy: (ll + rr) / (2 * window) as f64, corr });
        s += hop;
    }
    let mean_energy = windows.iter().map(|w| w.energy).sum::<f64>() / windows.len().max(1) as f64;
    let gate = mean_energy * 10f64.powf(WINDOW_GATE_DB / 10.0);
    let gated = |w: &Win| mean_energy > 0.0 && w.energy >= gate && w.corr.is_finite();
    let mut gated_corrs: Vec<f64> = windows.iter().filter(|w| gated(w)).map(|w| w.corr).collect();
    gated_corrs.sort_by(f64::total_cmp);

    let correlation_curve = with_curves.then(|| Curve {
        t0: range_start_seconds + CORRELATION_WINDOW_SECONDS / 2.0,
        hop: HOP_SECONDS,
        values: windows.iter().map(|w| if gated(w) { w.corr as f32 } else { f32::NAN }).collect(),
    });

    // ── Whole-range energies ──
    let (mut lr, mut ll, mut rr) = (0.0f64, 0.0f64, 0.0f64);
    for (&l, &r) in left.iter().zip(right) {
        let (l, r) = (l as f64, r as f64);
        lr += l * r;
        ll += l * l;
        rr += r * r;
    }
    // With M = (L+R)/2 and S = (L−R)/2: ΣM² = (ΣL² + ΣR² + 2ΣLR)/4, ΣS² = (ΣL² + ΣR² − 2ΣLR)/4.
    let mid = (ll + rr + 2.0 * lr) / 4.0;
    let side = (ll + rr - 2.0 * lr) / 4.0;
    let silent = ll + rr == 0.0;

    let stats = StereoStats {
        mono,
        correlation: (!silent && ll > 0.0 && rr > 0.0).then(|| lr / (ll * rr).sqrt()),
        correlation_p5: percentile(&gated_corrs, 0.05),
        negative_fraction: (!gated_corrs.is_empty())
            .then(|| gated_corrs.iter().filter(|&&c| c < 0.0).count() as f64 / gated_corrs.len() as f64),
        side_to_mid: (!silent && mid > 0.0 && side > 0.0).then(|| 10.0 * (side / mid).log10()),
        balance: (ll > 0.0 && rr > 0.0).then(|| 10.0 * (ll / rr).log10()),
    };

    StereoReport {
        stats,
        goniometer: goniometer(left, right),
        goniometer_size: GONIO_SIZE,
        correlation: correlation_curve,
    }
}

fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let pos = p * (sorted.len() - 1) as f64;
    let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
    Some(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo as f64))
}

/// 2D histogram of (side, mid) positions — the classic "phase scope" rotated 45°. Auto-scaled
/// so tracks at different levels fill the scope similarly.
fn goniometer(left: &[f32], right: &[f32]) -> Vec<f32> {
    let n = GONIO_SIZE;
    let mut grid = vec![0.0f32; n * n];
    let step = (left.len() / GONIO_MAX_POINTS).max(1);
    let points: Vec<(f32, f32)> = left
        .iter()
        .zip(right)
        .step_by(step)
        .map(|(&l, &r)| ((l - r) * 0.5, (l + r) * 0.5))
        .collect();
    let mut radii: Vec<f32> = points.iter().map(|(s, m)| s.abs().max(m.abs())).filter(|&r| r > 0.0).collect();
    if radii.is_empty() {
        return grid;
    }
    radii.sort_by(f32::total_cmp);
    let scale = radii[((radii.len() - 1) as f64 * GONIO_SCALE_QUANTILE) as usize].max(1e-9);

    let half = n as f32 / 2.0;
    for (s, m) in points {
        let x = ((s / scale) * half + half).floor();
        let y = (half - (m / scale) * half).floor();
        if (0.0..n as f32).contains(&x) && (0.0..n as f32).contains(&y) {
            grid[y as usize * n + x as usize] += 1.0;
        }
    }
    let max = grid.iter().cloned().fold(0.0f32, f32::max);
    if max > 0.0 {
        grid.iter_mut().for_each(|v| *v /= max);
    }
    grid
}
