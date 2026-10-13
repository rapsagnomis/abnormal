//! Band activity: how much of the moment's energy each frequency band carries, over time.
//!
//! The EQ match tab uses it to find, for each suggested move, the passage of the track where the
//! move matters most (its range furthest from the reference's median). Levels are relative to
//! the level of the surrounding 3 s, so loud and quiet passages compare on balance, not loudness.

use serde::Serialize;

use crate::decode::AudioData;
use crate::stft::{Stft, db, log_bands};

pub const CELL_SECONDS: f64 = 0.5;
const FFT_SIZE: usize = 4096;
const HOP: usize = FFT_SIZE / 2;
/// Half-octave bands from 31 Hz to 16 kHz.
const BAND_RANGE_HZ: (f64, f64) = (31.25, 16000.0);
const BAND_COUNT: usize = 18;
/// Window for the reference level each cell is measured against.
const CONTEXT_SECONDS: f64 = 3.0;
/// Cells this far below the mean cell power are silence or fade tails: no reading.
const GATE_DB: f64 = -30.0;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BandActivity {
    /// Band edges, Hz.
    pub bands: Vec<[f64; 2]>,
    /// Cell `i` is centred at `t0 + i * hop` seconds.
    pub t0: f64,
    pub hop: f64,
    /// `levels[band][cell]`: band energy relative to the surrounding 3 s, dB; null = gated.
    pub levels: Vec<Vec<Option<f32>>>,
}

pub fn analyze(audio: &AudioData, start: usize, end: usize) -> BandActivity {
    let end = end.min(audio.frames());
    let start = start.min(end);
    let rate = audio.sample_rate as f64;
    let cell = (CELL_SECONDS * rate).round() as usize;
    let n_cells = (end - start) / cell;
    let bands = log_bands(BAND_RANGE_HZ.0, BAND_RANGE_HZ.1, BAND_COUNT);
    let mut stft = Stft::new(audio, FFT_SIZE);

    // Band energies per cell.
    let mut energy = vec![vec![0.0f64; n_cells]; BAND_COUNT];
    let frames = (cell / HOP).max(1);
    for c in 0..n_cells {
        let c0 = start + c * cell;
        for i in 0..frames {
            let centre = c0 + (2 * i + 1) * cell / (2 * frames);
            stft.frame(centre as isize - (FFT_SIZE / 2) as isize);
            for (b, &(lo, hi)) in bands.iter().enumerate() {
                energy[b][c] += stft.band_energy(lo, hi) / frames as f64;
            }
        }
    }

    let total: Vec<f64> = (0..n_cells).map(|c| energy.iter().map(|b| b[c]).sum()).collect();
    let mean = total.iter().sum::<f64>() / n_cells.max(1) as f64;
    let gate = mean * 10f64.powf(GATE_DB / 10.0);
    // Mean total power over the surrounding window, ignoring gated cells.
    let half = ((CONTEXT_SECONDS / CELL_SECONDS) / 2.0).round() as usize;
    let context: Vec<f64> = (0..n_cells)
        .map(|c| {
            let window = &total[c.saturating_sub(half)..(c + half + 1).min(n_cells)];
            let live: Vec<f64> = window.iter().copied().filter(|&p| p >= gate).collect();
            live.iter().sum::<f64>() / live.len().max(1) as f64
        })
        .collect();

    let levels = energy
        .iter()
        .map(|band| {
            (0..n_cells)
                .map(|c| (mean > 0.0 && total[c] >= gate).then(|| (db(band[c]) - db(context[c])).max(-80.0) as f32))
                .collect()
        })
        .collect();

    BandActivity {
        bands: bands.iter().map(|&(lo, hi)| [lo, hi]).collect(),
        t0: start as f64 / rate + CELL_SECONDS / 2.0,
        hop: CELL_SECONDS,
        levels,
    }
}
