//! Sonic fingerprint of a track and the distance between two fingerprints.
//!
//! A fingerprint is a handful of values from the regular analysis, in three groups: tonal balance
//! (spectrum shape), dynamics and stereo image. Each value is compared in units of its spread over
//! the library (z-scores), so a 1 dB difference in sub-bass, where tracks vary a lot, counts less
//! than 1 dB in the mids, where they don't.

use serde::{Deserialize, Serialize};

use crate::dynamics::DynamicsStats;
use crate::loudness::LoudnessStats;
use crate::spectrum::SpectrumReport;
use crate::stereo::StereoStats;

/// Spectrum points used for the tonal shape: every 8th grid point (1/3 octave) from ~32 Hz to
/// ~16 kHz. Lossy files are usually low-passed at 16 kHz, so air above that says more about the
/// encoder than the mix.
const TONAL_FIRST: usize = 16;
const TONAL_LAST: usize = 232;
const TONAL_STEP: usize = 8;
/// Band widths below this (near mono) are all treated alike.
const WIDTH_FLOOR_DB: f64 = -30.0;
/// Smallest spread used for z-scores, per value, so a near-constant value can't dominate.
const MIN_SPREAD: f64 = 0.25;

pub const GROUPS: usize = 3;

/// Values per group: tonal (dB, mean removed), dynamics, stereo. `None` = undefined for this track.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Features {
    /// Spectrum at 1/3-octave points, dB relative to its own mean.
    pub tonal: Vec<Option<f32>>,
    /// LRA, PLR, PSR median, 50 ms crest median, TT DR, log2 onset rate, attack rise.
    pub dynamics: Vec<Option<f32>>,
    /// Correlation, then side − mid width for each of the 7 bands.
    pub stereo: Vec<Option<f32>>,
}

impl Features {
    pub fn new(loudness: &LoudnessStats, dynamics: &DynamicsStats, spectrum: &SpectrumReport, stereo: &StereoStats) -> Self {
        let points: Vec<f64> = (TONAL_FIRST..=TONAL_LAST.min(spectrum.level.len() - 1))
            .step_by(TONAL_STEP)
            .map(|i| spectrum.level[i] as f64)
            .collect();
        // Silent or empty spectra are floored at −120 dB; there's no shape to compare then.
        let has_shape = points.iter().any(|&v| v > -100.0);
        let mean = points.iter().sum::<f64>() / points.len().max(1) as f64;
        let tonal = points.iter().map(|&v| has_shape.then(|| (v - mean) as f32)).collect();

        let dynamics = [
            loudness.range,
            loudness.plr,
            dynamics.psr_median,
            dynamics.crest_short_median,
            dynamics.dr,
            // Rates are compared as ratios: 2 vs 4 onsets/s is as different as 4 vs 8.
            dynamics.onset_rate.map(|r| (r + 0.25).log2()),
            dynamics.onset_rise,
        ];

        let widths = spectrum.bands.iter().map(|b| b.width.map(|w| w.max(WIDTH_FLOOR_DB)));
        let stereo = std::iter::once(stereo.correlation).chain(widths);

        let to_f32 = |v: Option<f64>| v.filter(|x| x.is_finite()).map(|x| x as f32);
        Features {
            tonal,
            dynamics: dynamics.into_iter().map(to_f32).collect(),
            stereo: stereo.map(to_f32).collect(),
        }
    }

    pub fn groups(&self) -> [&[Option<f32>]; GROUPS] {
        [&self.tonal, &self.dynamics, &self.stereo]
    }
}

/// Spread (standard deviation) of every value over a set of fingerprints.
pub struct Spread([Vec<f64>; GROUPS]);

impl Spread {
    pub fn of<'a>(all: impl Iterator<Item = &'a Features> + Clone) -> Self {
        let mut groups: [Vec<f64>; GROUPS] = Default::default();
        let Some(first) = all.clone().next() else {
            return Spread(groups);
        };
        for (g, values) in first.groups().iter().enumerate() {
            groups[g] = (0..values.len())
                .map(|i| {
                    let (mut n, mut sum, mut sq) = (0.0, 0.0, 0.0);
                    for f in all.clone() {
                        if let Some(Some(v)) = f.groups()[g].get(i) {
                            let v = *v as f64;
                            n += 1.0;
                            sum += v;
                            sq += v * v;
                        }
                    }
                    let var = if n > 1.0 { (sq - sum * sum / n) / (n - 1.0) } else { 1.0 };
                    var.max(0.0).sqrt().max(MIN_SPREAD)
                })
                .collect();
        }
        Spread(groups)
    }
}

/// Per-group distances (RMS of z-score differences), `None` where the tracks share no values.
pub fn distances(a: &Features, b: &Features, spread: &Spread) -> [Option<f64>; GROUPS] {
    let (ga, gb) = (a.groups(), b.groups());
    std::array::from_fn(|g| {
        let (mut n, mut sum) = (0usize, 0.0);
        for (i, (x, y)) in ga[g].iter().zip(gb[g]).enumerate() {
            if let (Some(x), Some(y)) = (x, y) {
                let s = spread.0[g].get(i).copied().unwrap_or(1.0);
                sum += ((*x as f64 - *y as f64) / s).powi(2);
                n += 1;
            }
        }
        (n > 0).then(|| (sum / n as f64).sqrt())
    })
}

/// Weighted RMS of the group distances that are defined.
pub fn combine(d: &[Option<f64>; GROUPS], weights: &[f64; GROUPS]) -> Option<f64> {
    let (mut sum, mut w) = (0.0, 0.0);
    for (d, &wg) in d.iter().zip(weights) {
        if let Some(d) = d {
            sum += wg * d * d;
            w += wg;
        }
    }
    (w > 0.0).then(|| (sum / w).sqrt())
}

/// Distance → 0–100 similarity. Two unrelated tracks sit around d ≈ 1.4 (≈ 25%).
pub fn score(d: f64) -> f64 {
    100.0 * (-d).exp()
}
