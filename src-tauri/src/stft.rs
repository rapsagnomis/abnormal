//! Short-time power spectra, shared by the spectrogram, section detection and band activity.

use realfft::RealFftPlanner;
use realfft::num_complex::Complex;

use crate::decode::AudioData;

/// Computes Hann-windowed power spectra of single frames: the mean of the two channels' power
/// (a mono file counts as both), scaled like `spectrum`'s PSD: summing bins gives mean-square
/// power, independent of FFT size and sample rate.
pub struct Stft<'a> {
    left: &'a [f32],
    right: &'a [f32],
    mono: bool,
    pub bin_hz: f64,
    window: Vec<f32>,
    fft: std::sync::Arc<dyn realfft::RealToComplex<f32>>,
    in_buf: Vec<f32>,
    out_l: Vec<Complex<f32>>,
    out_r: Vec<Complex<f32>>,
    scale: f64,
    /// Power per bin of the last frame (`size / 2 + 1` bins).
    pub power: Vec<f64>,
}

impl<'a> Stft<'a> {
    pub fn new(audio: &'a AudioData, size: usize) -> Self {
        let left = &audio.channels[0][..];
        let right = &audio.channels.get(1).unwrap_or(&audio.channels[0])[..];
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(size);
        let window: Vec<f32> = (0..size)
            .map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / size as f64).cos()) as f32)
            .collect();
        let window_power: f64 = window.iter().map(|&w| (w as f64).powi(2)).sum();
        let out_l = fft.make_output_vec();
        let bins = out_l.len();
        Self {
            left,
            right,
            mono: audio.channels.len() == 1,
            bin_hz: audio.sample_rate as f64 / size as f64,
            window,
            in_buf: fft.make_input_vec(),
            out_r: fft.make_output_vec(),
            out_l,
            fft,
            scale: 2.0 / (size as f64 * window_power),
            power: vec![0.0; bins],
        }
    }

    /// Power spectrum of the frame starting at sample `start` (zero-padded past the end of the
    /// audio), into `self.power`.
    pub fn frame(&mut self, start: isize) {
        let n = self.left.len() as isize;
        let fill = |src: &[f32], buf: &mut [f32], window: &[f32]| {
            for (i, (b, w)) in buf.iter_mut().zip(window).enumerate() {
                let j = start + i as isize;
                *b = if j >= 0 && j < n { src[j as usize] * w } else { 0.0 };
            }
        };
        fill(self.left, &mut self.in_buf, &self.window);
        // Inputs are only zero-length or exactly `size`, so processing can't fail.
        let _ = self.fft.process(&mut self.in_buf, &mut self.out_l);
        if self.mono {
            for (p, c) in self.power.iter_mut().zip(&self.out_l) {
                *p = c.norm_sqr() as f64 * self.scale;
            }
            return;
        }
        fill(self.right, &mut self.in_buf, &self.window);
        let _ = self.fft.process(&mut self.in_buf, &mut self.out_r);
        for ((p, l), r) in self.power.iter_mut().zip(&self.out_l).zip(&self.out_r) {
            *p = (l.norm_sqr() + r.norm_sqr()) as f64 * 0.5 * self.scale;
        }
    }

    /// Energy in [lo, hi) Hz of the last frame. Bands narrower than a bin take the interpolated
    /// power at their centre, scaled by their width, so log-spaced bands stay smooth at low
    /// frequencies.
    pub fn band_energy(&self, lo: f64, hi: f64) -> f64 {
        band_energy(&self.power, self.bin_hz, lo, hi)
    }
}

pub fn band_energy(power: &[f64], bin_hz: f64, lo: f64, hi: f64) -> f64 {
    let nyquist = (power.len() - 1) as f64 * bin_hz;
    let hi = hi.min(nyquist);
    if hi <= lo {
        return 0.0;
    }
    let first = (lo / bin_hz).ceil() as usize;
    let last = ((hi / bin_hz).ceil() as usize).min(power.len());
    let mean = if last > first {
        power[first..last].iter().sum::<f64>() / (last - first) as f64
    } else {
        let pos = (lo + hi) / 2.0 / bin_hz;
        let i = (pos.floor() as usize).min(power.len() - 2);
        let t = pos - i as f64;
        power[i] * (1.0 - t) + power[i + 1] * t
    };
    mean * (hi - lo) / bin_hz
}

/// `n` log-spaced bands covering [lo, hi] Hz, as (lower edge, upper edge).
pub fn log_bands(lo: f64, hi: f64, n: usize) -> Vec<(f64, f64)> {
    let ratio = (hi / lo).powf(1.0 / n as f64);
    (0..n).map(|i| (lo * ratio.powi(i as i32), lo * ratio.powi(i as i32 + 1))).collect()
}

pub fn db(power: f64) -> f64 {
    10.0 * power.max(1e-30).log10()
}
