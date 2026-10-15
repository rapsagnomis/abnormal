use serde::Serialize;

use crate::decode::AudioData;

/// Downsampled waveform for display: the min/max sample across all channels per bucket.
#[derive(Serialize)]
pub struct Peaks {
    pub buckets: usize,
    pub min: Vec<f32>,
    pub max: Vec<f32>,
}

pub fn compute_peaks(audio: &AudioData, buckets: usize) -> Peaks {
    compute_peaks_range(audio, 0, audio.frames(), buckets)
}

/// Peaks for frames `start..end`. When zoomed in past one sample per bucket, buckets are
/// capped at the frame count so each bucket is a single sample.
pub fn compute_peaks_range(audio: &AudioData, start: usize, end: usize, buckets: usize) -> Peaks {
    let end = end.min(audio.frames());
    let start = start.min(end);
    let frames = end - start;
    let buckets = buckets.min(frames).max(1);
    let mut min = Vec::with_capacity(buckets);
    let mut max = Vec::with_capacity(buckets);

    for b in 0..buckets {
        let b_start = start + b * frames / buckets;
        let b_end = (start + (b + 1) * frames / buckets).max(b_start + 1).min(audio.frames());
        let (mut lo, mut hi) = (f32::MAX, f32::MIN);
        for ch in &audio.channels {
            for &s in &ch[b_start..b_end] {
                lo = lo.min(s);
                hi = hi.max(s);
            }
        }
        if b_end <= b_start {
            (lo, hi) = (0.0, 0.0);
        }
        min.push(lo);
        max.push(hi);

    }

    Peaks { buckets, min, max }
}
