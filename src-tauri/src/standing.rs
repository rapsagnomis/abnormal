//! Where a track sits within the library: for a handful of mix qualities (brightness, low end,
//! width, punch, loudness…), its percentile among the library's tracks and the library's spread.
//!
//! Everything is read off `similarity::Features` (plus integrated loudness), which every library
//! entry already holds, so the mix, the reference and the library are measured the same way.

use serde::{Deserialize, Serialize};

use crate::similarity::Features;

/// A track to place: its fingerprint and integrated loudness.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub features: Features,
    pub integrated: Option<f64>,
}

/// One quality: the library's spread and where each given track falls in it.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Standing {
    pub key: &'static str,
    pub label: &'static str,
    pub unit: &'static str,
    pub group: &'static str,
    /// What a higher value means, for the reader.
    pub higher: &'static str,
    /// Library values at 0, 5, …, 100 %.
    pub quantiles: Vec<f64>,
    /// Per given track: its value and percentile (0–100) in the library, if defined.
    pub values: Vec<Option<f64>>,
    pub percentiles: Vec<Option<f64>>,
    /// Library tracks with this value.
    pub count: usize,
}

struct Metric {
    key: &'static str,
    label: &'static str,
    unit: &'static str,
    group: &'static str,
    higher: &'static str,
    value: fn(&Features, Option<f64>) -> Option<f64>,
}

/// Frequency of the tonal fingerprint's point `i` (every 8th point of the 24/oct grid from 20 Hz,
/// starting at the 16th): ≈ 31.7 Hz · 2^(i/3).
fn tonal_hz(i: usize) -> f64 {
    20.0 * 2f64.powf((16 + 8 * i) as f64 / 24.0)
}

/// Mean tonal level (dB, relative to the track's own mean) between `lo` and `hi` Hz.
fn tonal_mean(f: &Features, lo: f64, hi: f64) -> Option<f64> {
    let values: Vec<f64> = f
        .tonal
        .iter()
        .enumerate()
        .filter(|(i, _)| (lo..=hi).contains(&tonal_hz(*i)))
        .filter_map(|(_, v)| v.map(f64::from))
        .collect();
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

fn tonal_diff(f: &Features, band: (f64, f64), reference: (f64, f64)) -> Option<f64> {
    Some(tonal_mean(f, band.0, band.1)? - tonal_mean(f, reference.0, reference.1)?)
}

fn dynamics(f: &Features, i: usize) -> Option<f64> {
    f.dynamics.get(i).copied().flatten().map(f64::from)
}

/// Mean side − mid width over bands `first..=last` (0 = sub … 6 = air).
fn width(f: &Features, first: usize, last: usize) -> Option<f64> {
    let values: Vec<f64> = (first..=last).filter_map(|b| f.stereo.get(1 + b).copied().flatten().map(f64::from)).collect();
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

/// The mids the tonal qualities are measured against.
const MIDS: (f64, f64) = (250.0, 2000.0);

const METRICS: [Metric; 11] = [
    Metric { key: "brightness", label: "Brightness", unit: "dB", group: "Tonal", higher: "brighter", value: |f, _| tonal_diff(f, (2500.0, 10000.0), MIDS) },
    Metric { key: "lowEnd", label: "Low end", unit: "dB", group: "Tonal", higher: "more low end", value: |f, _| tonal_diff(f, (32.0, 125.0), MIDS) },
    Metric { key: "lowMids", label: "Low-mids", unit: "dB", group: "Tonal", higher: "thicker (or muddier)", value: |f, _| tonal_diff(f, (200.0, 500.0), (500.0, 4000.0)) },
    Metric { key: "loudness", label: "Loudness", unit: "LUFS", group: "Dynamics", higher: "louder", value: |_, i| i },
    Metric { key: "plr", label: "PLR", unit: "LU", group: "Dynamics", higher: "less limited", value: |f, _| dynamics(f, 1) },
    Metric { key: "psr", label: "PSR", unit: "LU", group: "Dynamics", higher: "more open, less compressed", value: |f, _| dynamics(f, 2) },
    Metric { key: "punch", label: "Punch", unit: "dB", group: "Dynamics", higher: "transients stand out more (crest, 50 ms)", value: |f, _| dynamics(f, 3) },
    Metric { key: "lra", label: "Loudness range", unit: "LU", group: "Dynamics", higher: "more movement between parts", value: |f, _| dynamics(f, 0) },
    Metric { key: "width", label: "Width", unit: "dB", group: "Stereo", higher: "wider (side vs mid, 250 Hz–8 kHz)", value: |f, _| width(f, 2, 5) },
    Metric { key: "bassWidth", label: "Bass width", unit: "dB", group: "Stereo", higher: "wider low end (below 250 Hz)", value: |f, _| width(f, 0, 1) },
    Metric { key: "correlation", label: "Correlation", unit: "", group: "Stereo", higher: "more mono-compatible", value: |f, _| f.stereo.first().copied().flatten().map(f64::from) },
];

/// Value at quantile `q` (0–1) of sorted values.
fn quantile(sorted: &[f64], q: f64) -> f64 {
    let pos = q * (sorted.len() - 1) as f64;
    let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
    sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo as f64)
}

/// Percentile (0–100) of `v` among sorted values: the share below it, ties counting half.
fn percentile_of(sorted: &[f64], v: f64) -> f64 {
    let below = sorted.partition_point(|&x| x < v);
    let equal = sorted[below..].partition_point(|&x| x <= v);
    100.0 * (below as f64 + equal as f64 / 2.0) / sorted.len() as f64
}

/// Standing of each input among `population` (fingerprint and integrated loudness per track).
pub fn standings(inputs: &[Option<Input>], population: &[(&Features, Option<f64>)]) -> Vec<Standing> {
    METRICS
        .iter()
        .filter_map(|m| {
            let mut values: Vec<f64> = population.iter().filter_map(|(f, i)| (m.value)(f, *i)).filter(|v| v.is_finite()).collect();
            if values.len() < 2 {
                return None;
            }
            values.sort_by(f64::total_cmp);
            let own: Vec<Option<f64>> = inputs.iter().map(|t| t.as_ref().and_then(|t| (m.value)(&t.features, t.integrated))).collect();
            Some(Standing {
                key: m.key,
                label: m.label,
                unit: m.unit,
                group: m.group,
                higher: m.higher,
                quantiles: (0..=20).map(|q| quantile(&values, q as f64 / 20.0)).collect(),
                percentiles: own.iter().map(|v| v.map(|v| percentile_of(&values, v))).collect(),
                values: own,
                count: values.len(),
            })
        })
        .collect()
}
