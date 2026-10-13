//! Song structure: split a track into sections (intro, verse, chorus, …) and label sections that
//! sound alike with the same letter.
//!
//! Each 0.5 s cell gets a feature vector — timbre (octave-band levels), harmony (chroma) and
//! loudness, each z-scored over the track. Boundaries are peaks of Foote's checkerboard novelty
//! on the cells' self-similarity matrix; sections are then grouped by distance between their mean
//! feature vectors.

use serde::Serialize;

use crate::decode::AudioData;
use crate::stft::{Stft, db, log_bands};

const CELL_SECONDS: f64 = 0.5;
const FFT_SIZE: usize = 4096;
const HOP: usize = FFT_SIZE / 2;
/// Half-width of the novelty kernel: how much context either side of a boundary is compared.
const KERNEL_SECONDS: f64 = 8.0;
const MIN_SECTION_SECONDS: f64 = 8.0;
/// A novelty peak must exceed mean + this × std to count as a boundary…
const PEAK_THRESHOLD_STD: f64 = 0.0;
/// …and differ from what came before by at least this much (mean distance across the boundary
/// minus within each side, in normalised feature units), so steady material isn't split.
const MIN_NOVELTY: f64 = 0.15;
/// Smallest spread used when normalising each feature group (timbre dB, chroma share, level dB):
/// changes much smaller than these are not structure.
const SPREAD_FLOORS: [f64; 3] = [2.0, 0.02, 2.0];
/// Sections join a group when closer than this fraction of the median distance between sections.
const GROUP_THRESHOLD: f64 = 0.6;
const TIMBRE_BANDS: usize = 8;
const CHROMA_RANGE_HZ: (f64, f64) = (80.0, 5000.0);
/// Floor for levels, dB, so digital silence doesn't dominate the normalisation.
const FLOOR_DB: f64 = -100.0;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    /// Seconds.
    pub start: f64,
    pub end: f64,
    /// Sections with the same label sound alike: 0 = first kind heard, 1 = the next, …
    pub label: usize,
    /// Mean power relative to the whole range, dB.
    pub level: f64,
}

/// Feature vectors per cell, before normalisation: timbre bands (dB), chroma (fractions), level.
fn cell_features(audio: &AudioData, start: usize, end: usize) -> (Vec<Vec<f64>>, Vec<f64>) {
    let cell = (CELL_SECONDS * audio.sample_rate as f64).round() as usize;
    let n_cells = (end - start) / cell;
    let bands = log_bands(40.0, 16000.0, TIMBRE_BANDS);
    let mut stft = Stft::new(audio, FFT_SIZE);
    let pitch_class: Vec<Option<usize>> = (0..stft.bins())
        .map(|k| {
            let f = k as f64 * stft.bin_hz;
            (CHROMA_RANGE_HZ.0..CHROMA_RANGE_HZ.1)
                .contains(&f)
                .then(|| (12.0 * (f / 440.0).log2()).round().rem_euclid(12.0) as usize)
        })
        .collect();

    let mut features = Vec::with_capacity(n_cells);
    let mut powers = Vec::with_capacity(n_cells);
    for c in 0..n_cells {
        let c0 = start + c * cell;
        let frames = (cell / HOP).max(1);
        let mut band = vec![0.0; TIMBRE_BANDS];
        let mut chroma = [0.0f64; 12];
        let mut total = 0.0;
        for i in 0..frames {
            let centre = c0 + (2 * i + 1) * cell / (2 * frames);
            stft.frame(centre as isize - (FFT_SIZE / 2) as isize);
            for (b, &(lo, hi)) in band.iter_mut().zip(&bands) {
                *b += stft.band_energy(lo, hi);
            }
            for (p, pc) in stft.power.iter().zip(&pitch_class) {
                if let Some(pc) = pc {
                    chroma[*pc] += p;
                }
            }
            total += stft.power.iter().sum::<f64>();
        }
        let chroma_sum: f64 = chroma.iter().sum();
        let mut v: Vec<f64> = band.iter().map(|&e| db(e / frames as f64).max(FLOOR_DB)).collect();
        v.extend(chroma.iter().map(|&c| if chroma_sum > 0.0 { c / chroma_sum } else { 0.0 }));
        let power = total / frames as f64;
        v.push(db(power).max(FLOOR_DB));
        features.push(v);
        powers.push(power);
    }
    (features, powers)
}

/// Z-score each dimension and weight the three groups (timbre, chroma, level) equally.
fn normalise(features: &mut [Vec<f64>]) {
    let Some(dims) = features.first().map(Vec::len) else { return };
    let n = features.len() as f64;
    for d in 0..dims {
        let group = if d < TIMBRE_BANDS { 0 } else if d < TIMBRE_BANDS + 12 { 1 } else { 2 };
        let weight = (1.0 / [TIMBRE_BANDS, 12, 1][group] as f64).sqrt();
        let mean = features.iter().map(|f| f[d]).sum::<f64>() / n;
        let sd = (features.iter().map(|f| (f[d] - mean).powi(2)).sum::<f64>() / n).sqrt();
        let sd = sd.max(SPREAD_FLOORS[group]);
        for f in features.iter_mut() {
            f[d] = (f[d] - mean) / sd * weight;
        }
    }
}

fn distance(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| (x - y).powi(2)).sum::<f64>().sqrt()
}

/// Foote novelty: correlate a Gaussian-tapered checkerboard kernel along the diagonal of the
/// self-similarity matrix (similarity = −distance). Scaled so a value is the weighted mean
/// distance across the boundary minus the mean distance within each side.
fn novelty(features: &[Vec<f64>], half: usize) -> Vec<f64> {
    let n = features.len();
    let sigma = half as f64 / 2.0;
    let taper = |k: isize| (-((k as f64 + 0.5).powi(2)) / (2.0 * sigma * sigma)).exp();
    let side: f64 = (0..half as isize).map(taper).sum();
    let norm = 2.0 * side * side;
    (0..n)
        .map(|i| {
            let mut sum = 0.0;
            for a in -(half as isize)..half as isize {
                let ia = i as isize + a;
                if ia < 0 || ia >= n as isize {
                    continue;
                }
                for b in -(half as isize)..half as isize {
                    let ib = i as isize + b;
                    if ib < 0 || ib >= n as isize {
                        continue;
                    }
                    // Same side of `i` → similar is expected (+), across → dissimilar (−).
                    let sign = if (a < 0) == (b < 0) { 1.0 } else { -1.0 };
                    sum += sign * taper(a) * taper(b) * -distance(&features[ia as usize], &features[ib as usize]);
                }
            }
            sum / norm
        })
        .collect()
}

/// Boundary cells: novelty peaks above the threshold, strongest first, at least
/// `min_cells` from each other and from the ends.
fn pick_boundaries(nov: &[f64], min_cells: usize) -> Vec<usize> {
    let n = nov.len();
    let mean = nov.iter().sum::<f64>() / n as f64;
    let sd = (nov.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n as f64).sqrt();
    let threshold = (mean + PEAK_THRESHOLD_STD * sd).max(MIN_NOVELTY);
    let mut peaks: Vec<usize> = (1..n.saturating_sub(1))
        .filter(|&i| nov[i] > threshold && nov[i] >= nov[i - 1] && nov[i] > nov[i + 1])
        .collect();
    peaks.sort_by(|&a, &b| nov[b].total_cmp(&nov[a]));
    let mut chosen: Vec<usize> = Vec::new();
    for p in peaks {
        if p < min_cells || n - p < min_cells {
            continue;
        }
        if chosen.iter().all(|&c| c.abs_diff(p) >= min_cells) {
            chosen.push(p);
        }
    }
    chosen.sort_unstable();
    chosen
}

/// Group sections by the distance between their mean features; labels are numbered in order of
/// first appearance.
fn group(means: &[Vec<f64>]) -> Vec<usize> {
    let n = means.len();
    let mut pair_d: Vec<f64> = Vec::new();
    for i in 0..n {
        for j in i + 1..n {
            pair_d.push(distance(&means[i], &means[j]));
        }
    }
    pair_d.sort_by(f64::total_cmp);
    let threshold = pair_d.get(pair_d.len() / 2).copied().unwrap_or(0.0) * GROUP_THRESHOLD;

    let mut labels: Vec<usize> = Vec::with_capacity(n);
    let mut members: Vec<Vec<usize>> = Vec::new();
    for i in 0..n {
        // Nearest existing group by average distance to its members.
        let best = members
            .iter()
            .enumerate()
            .map(|(g, m)| (g, m.iter().map(|&j| distance(&means[i], &means[j])).sum::<f64>() / m.len() as f64))
            .min_by(|a, b| a.1.total_cmp(&b.1));
        match best {
            Some((g, d)) if d < threshold => {
                members[g].push(i);
                labels.push(g);
            }
            _ => {
                members.push(vec![i]);
                labels.push(members.len() - 1);
            }
        }
    }
    labels
}

pub fn analyze(audio: &AudioData, start: usize, end: usize) -> Vec<Section> {
    let end = end.min(audio.frames());
    let start = start.min(end);
    let rate = audio.sample_rate as f64;
    let (mut features, powers) = cell_features(audio, start, end);
    let mean_power = powers.iter().sum::<f64>() / powers.len().max(1) as f64;
    let whole = |s: f64, e: f64| vec![Section { start: s, end: e, label: 0, level: 0.0 }];
    let (t_start, t_end) = (start as f64 / rate, end as f64 / rate);
    let min_cells = (MIN_SECTION_SECONDS / CELL_SECONDS).round() as usize;
    if features.len() < 2 * min_cells || mean_power <= 0.0 {
        return whole(t_start, t_end);
    }

    normalise(&mut features);
    let nov = novelty(&features, (KERNEL_SECONDS / CELL_SECONDS).round() as usize);
    let mut edges = vec![0];
    edges.extend(pick_boundaries(&nov, min_cells));
    edges.push(features.len());

    let means: Vec<Vec<f64>> = edges
        .windows(2)
        .map(|w| {
            let cells = &features[w[0]..w[1]];
            (0..cells[0].len()).map(|d| cells.iter().map(|f| f[d]).sum::<f64>() / cells.len() as f64).collect()
        })
        .collect();
    let labels = group(&means);

    edges
        .windows(2)
        .zip(labels)
        .map(|(w, label)| {
            let p = powers[w[0]..w[1]].iter().sum::<f64>() / (w[1] - w[0]) as f64;
            let at = |cell: usize| t_start + cell as f64 * CELL_SECONDS;
            Section {
                start: at(w[0]),
                // The last section runs to the end of the range, including any partial cell.
                end: if w[1] == features.len() { t_end } else { at(w[1]) },
                label,
                level: db(p) - db(mean_power),
            }
        })
        .collect()
}
