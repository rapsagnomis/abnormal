//! Spectrogram image for a time range: log-frequency rows × time columns, one byte per cell.

use crate::decode::AudioData;
use crate::stft::{Stft, db, log_bands};

pub const MIN_HZ: f64 = 30.0;
pub const MAX_HZ: f64 = 20000.0;
const FFT_SIZE: usize = 4096;
/// Bytes map linearly from FLOOR_DB (0) to 0 dB (255).
const FLOOR_DB: f64 = -120.0;

/// Energy per 1/3 octave (pink noise is flat, matching the tonal chart) at each cell, quantised
/// to a byte. Row-major, row 0 is the highest frequency. Columns covering more than half an FFT
/// average all frames inside them, so zoomed-out views don't skip material.
pub fn compute(audio: &AudioData, start: usize, end: usize, columns: usize, rows: usize) -> Vec<u8> {
    let mut out = vec![0u8; columns * rows];
    let end = end.min(audio.frames());
    if columns == 0 || rows == 0 || end <= start {
        return out;
    }
    let bands = log_bands(MIN_HZ, MAX_HZ, rows);
    // Scale each row's energy to a 1/3-octave equivalent so values don't depend on `rows`.
    let row_octaves = (MAX_HZ / MIN_HZ).log2() / rows as f64;
    let norm = db((1.0 / 3.0) / row_octaves);
    let span = (end - start) as f64 / columns as f64;
    let hop = FFT_SIZE / 2;

    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    let per = columns.div_ceil(threads);
    let mut columns_out: Vec<Vec<u8>> = vec![Vec::new(); columns];
    std::thread::scope(|scope| {
        for (chunk_index, chunk) in columns_out.chunks_mut(per).enumerate() {
            let bands = &bands;
            scope.spawn(move || {
                let mut stft = Stft::new(audio, FFT_SIZE);
                let mut acc = vec![0.0f64; rows];
                for (k, col) in chunk.iter_mut().enumerate() {
                    let c = chunk_index * per + k;
                    let c0 = start as f64 + c as f64 * span;
                    let c1 = c0 + span;
                    // Frame centres within the column; at least one, at its middle.
                    let centres: Vec<f64> = if span >= hop as f64 {
                        let n = (span / hop as f64).floor() as usize;
                        (0..n).map(|i| c0 + (i as f64 + 0.5) * span / n as f64).collect()
                    } else {
                        vec![(c0 + c1) / 2.0]
                    };
                    acc.fill(0.0);
                    for &centre in &centres {
                        stft.frame(centre as isize - (FFT_SIZE / 2) as isize);
                        for (a, &(lo, hi)) in acc.iter_mut().zip(bands) {
                            *a += stft.band_energy(lo, hi);
                        }
                    }
                    *col = acc
                        .iter()
                        .map(|&e| {
                            let v = db(e / centres.len() as f64) + norm;
                            ((v - FLOOR_DB) / -FLOOR_DB * 255.0).clamp(0.0, 255.0).round() as u8
                        })
                        .collect();
                }
            });
        }
    });

    for (c, col) in columns_out.iter().enumerate() {
        for (r, &v) in col.iter().enumerate() {
            out[(rows - 1 - r) * columns + c] = v;
        }
    }
    out
}
