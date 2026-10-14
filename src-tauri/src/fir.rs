//! Linear-phase FIR filtering in mid/side, used to hear the full (Matchering-style) EQ match:
//! the correction curves become zero-phase spectra, windowed impulse responses, and are applied
//! to a whole track offline by FFT convolution, with the filters' delay removed.

use realfft::RealFftPlanner;
use realfft::num_complex::Complex;

/// Frequency resolution aimed for, Hz: fine enough for the 1/6-octave grid down to ~40 Hz.
const RESOLUTION_HZ: f64 = 6.0;

/// Filter length for `rate`: a power of two giving about `RESOLUTION_HZ` per bin.
pub fn taps_for(rate: f64) -> usize {
    ((rate / RESOLUTION_HZ) as usize).next_power_of_two().max(1024)
}

/// Gain at `f` from a curve on the log-spaced `freqs`, interpolated in log frequency and held
/// beyond the ends.
fn gain_at(freqs: &[f64], curve_db: &[f32], f: f64) -> f64 {
    let n = freqs.len().min(curve_db.len());
    if n == 0 {
        return 0.0;
    }
    if f <= freqs[0] {
        return curve_db[0] as f64;
    }
    if f >= freqs[n - 1] {
        return curve_db[n - 1] as f64;
    }
    let i = freqs[..n].partition_point(|&x| x <= f) - 1;
    let t = (f / freqs[i]).log2() / (freqs[i + 1] / freqs[i]).log2();
    curve_db[i] as f64 * (1.0 - t) + curve_db[i + 1] as f64 * t
}

/// Linear-phase FIR of length `n` (delay `n / 2`) whose magnitude follows `curve_db` on `freqs`.
pub fn design(freqs: &[f64], curve_db: &[f32], rate: f64, n: usize) -> Vec<f32> {
    let ifft = RealFftPlanner::<f64>::new().plan_fft_inverse(n);
    let mut spectrum: Vec<Complex<f64>> = (0..n / 2 + 1)
        .map(|k| Complex::new(10f64.powf(gain_at(freqs, curve_db, k as f64 * rate / n as f64) / 20.0), 0.0))
        .collect();
    let mut impulse = ifft.make_output_vec();
    // Purely real bins, so the only possible error (non-zero imaginary DC/Nyquist) can't occur.
    let _ = ifft.process(&mut spectrum, &mut impulse);
    // The zero-phase response is centred on sample 0; move it to the middle and window it.
    (0..n)
        .map(|i| {
            let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos();
            (impulse[(i + n / 2) % n] / n as f64 * w) as f32
        })
        .collect()
}

/// Filter interleaved stereo `samples`: mid through `mid_fir`, side through `side_fir` (equal
/// lengths, as from `design`), compensating their delay so the output lines up with the input.
pub fn filter_mid_side(samples: &[f32], mid_fir: &[f32], side_fir: &[f32]) -> Vec<f32> {
    let frames = samples.len() / 2;
    let n = mid_fir.len();
    let size = 2 * n;
    let mut planner = RealFftPlanner::<f32>::new();
    let (fft, ifft) = (planner.plan_fft_forward(size), planner.plan_fft_inverse(size));
    let mut time = fft.make_input_vec();
    let mut freq = fft.make_output_vec();

    let mut response = |fir: &[f32]| {
        time.fill(0.0);
        time[..n].copy_from_slice(fir);
        let mut out = fft.make_output_vec();
        let _ = fft.process(&mut time, &mut out);
        out
    };
    let responses = [response(mid_fir), response(side_fir)];

    // Overlap-add in blocks of `n`: each block convolved with an `n`-tap filter fits in `2n`.
    let mut outputs = [vec![0.0f32; frames + size], vec![0.0f32; frames + size]];
    for (channel, (h, out)) in responses.iter().zip(outputs.iter_mut()).enumerate() {
        let sign = if channel == 0 { 1.0 } else { -1.0 };
        for block in (0..frames).step_by(n) {
            time.fill(0.0);
            for (i, t) in time[..n].iter_mut().enumerate() {
                if let Some(frame) = samples.get((block + i) * 2..(block + i) * 2 + 2) {
                    *t = 0.5 * (frame[0] + sign * frame[1]);
                }
            }
            let _ = fft.process(&mut time, &mut freq);
            for (x, y) in freq.iter_mut().zip(h) {
                *x *= y;
            }
            // DC and Nyquist are real for real signals; clear rounding residue, which the inverse rejects.
            freq[0].im = 0.0;
            if let Some(last) = freq.last_mut() {
                last.im = 0.0;
            }
            let _ = ifft.process(&mut freq, &mut time);
            for (o, t) in out[block..block + size].iter_mut().zip(&time) {
                *o += t / size as f32;
            }
        }
    }

    let delay = n / 2;
    let [mid, side] = &outputs;
    let mut stereo = Vec::with_capacity(frames * 2);
    for i in 0..frames {
        let (m, s) = (mid[i + delay], side[i + delay]);
        stereo.push(m + s);
        stereo.push(m - s);
    }
    stereo
}
