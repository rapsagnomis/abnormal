//! Decode/resample checks against real files.
//!
//! Set `SONIC_TEST_AUDIO` to a directory containing 3 s, 1 kHz sines at -6 dBFS:
//!   sine_44k_s16.wav (stereo), sine_96k_24.flac (stereo), sine_44k_mono.mp3
//! e.g. generated with (lavfi's `sine` source is only 1/8 amplitude, so use `aevalsrc`):
//!   ffmpeg -f lavfi -i 'aevalsrc=0.5*sin(2*PI*1000*t)|0.5*sin(2*PI*1000*t):s=44100:d=3' \
//!     -c:a pcm_s16le sine_44k_s16.wav
//! Tests are skipped when the variable is unset.

use std::path::PathBuf;

use crate::decode::{AudioData, decode_file};
use crate::peaks::compute_peaks;
use crate::player::PlaybackBuffer;

const MINUS_6_DB: f32 = 0.501;

fn fixture(name: &str) -> Option<PathBuf> {
    let dir = std::env::var_os("SONIC_TEST_AUDIO")?;
    Some(PathBuf::from(dir).join(name))
}

fn peak(audio: &AudioData) -> f32 {
    audio.channels.iter().flatten().fold(0.0f32, |m, s| m.max(s.abs()))
}

fn check_sine(name: &str, rate: u32, channels: usize) -> Option<AudioData> {
    let audio = decode_file(&fixture(name)?).unwrap();
    assert_eq!(audio.sample_rate, rate, "{name}: sample rate");
    assert_eq!(audio.channels.len(), channels, "{name}: channels");
    // MP3 adds encoder padding, but gapless decoding should trim most of it.
    assert!((audio.duration() - 3.0).abs() < 0.03, "{name}: duration {}", audio.duration());
    assert!((peak(&audio) - MINUS_6_DB).abs() < 0.02, "{name}: peak {}", peak(&audio));
    Some(audio)
}

#[test]
fn decodes_wav() {
    check_sine("sine_44k_s16.wav", 44100, 2);
}

#[test]
fn decodes_flac_hi_res() {
    check_sine("sine_96k_24.flac", 96000, 2);
}

#[test]
fn decodes_mp3_mono() {
    check_sine("sine_44k_mono.mp3", 44100, 1);
}

#[test]
fn resamples_to_device_rate() {
    let Some(audio) = check_sine("sine_44k_mono.mp3", 44100, 1) else { return };
    let buf = PlaybackBuffer::new(&audio, 48000).unwrap();
    let expected = (audio.frames() as f64 * 48000.0 / 44100.0).round() as i64;
    assert!((buf.frames() as i64 - expected).abs() <= 2, "{} vs {expected}", buf.frames());
    // Mono is duplicated to both sides and level is preserved through the resampler.
    let (l, r) = buf.frame(buf.frames() as usize / 2);
    assert_eq!(l, r);
    let pk = buf.samples().iter().fold(0.0f32, |m, s| m.max(s.abs()));
    assert!((pk - MINUS_6_DB).abs() < 0.02, "resampled peak {pk}");
}

#[test]
fn peaks_cover_signal() {
    let Some(audio) = check_sine("sine_44k_s16.wav", 44100, 2) else { return };
    let p = compute_peaks(&audio, 1000);
    assert_eq!(p.buckets, 1000);
    let max = p.max.iter().cloned().fold(f32::MIN, f32::max);
    let min = p.min.iter().cloned().fold(f32::MAX, f32::min);
    assert!((max - MINUS_6_DB).abs() < 0.02);
    assert!((min + MINUS_6_DB).abs() < 0.02);
}

// ── Loudness: EBU Tech 3341 / 3342 style signals, synthesised in place ─────────────────

mod loudness {
    use std::f64::consts::PI;

    use crate::decode::AudioData;
    use crate::loudness::analyze;

    fn db_to_amp(db: f64) -> f64 {
        10f64.powf(db / 20.0)
    }

    /// 1 kHz sine segments of (dBFS peak, seconds), concatenated.
    fn sine(rate: u32, channels: usize, segments: &[(f64, f64)]) -> AudioData {
        let mut data = Vec::new();
        let mut n = 0u64;
        for &(db, secs) in segments {
            let amp = db_to_amp(db);
            for _ in 0..(secs * rate as f64) as u64 {
                data.push((amp * (2.0 * PI * 1000.0 * n as f64 / rate as f64).sin()) as f32);
                n += 1;
            }
        }
        AudioData { sample_rate: rate, channels: vec![data; channels] }
    }

    fn close(actual: Option<f64>, expected: f64, tol: f64, what: &str) {
        let a = actual.unwrap_or_else(|| panic!("{what}: undefined"));
        assert!((a - expected).abs() <= tol, "{what}: {a:.3}, expected {expected} ±{tol}");
    }

    #[test]
    fn tech3341_case1_stereo_sine_at_minus_23() {
        let audio = sine(48000, 2, &[(-23.0, 20.0)]);
        let r = analyze(&audio, 0, audio.frames(), true).unwrap();
        close(r.stats.integrated, -23.0, 0.1, "integrated");
        close(r.stats.momentary_max, -23.0, 0.1, "momentary max");
        close(r.stats.short_term_max, -23.0, 0.1, "short-term max");
        close(r.stats.sample_peak, -23.0, 0.01, "sample peak");

        let c = r.curves.unwrap();
        // One reading per 100 ms block once the window is full.
        assert_eq!(c.momentary.values.len(), 200 - 3);
        assert_eq!(c.short_term.values.len(), 200 - 29);
        assert!((c.momentary.t0 - 0.2).abs() < 1e-9 && (c.short_term.t0 - 1.5).abs() < 1e-9);
        assert!(c.short_term.values.iter().all(|v| (v + 23.0).abs() < 0.1));
    }

    #[test]
    fn tech3341_case2_44k1() {
        let audio = sine(44100, 2, &[(-33.0, 20.0)]);
        let r = analyze(&audio, 0, audio.frames(), false).unwrap();
        close(r.stats.integrated, -33.0, 0.1, "integrated");
        assert!(r.curves.is_none());
    }

    #[test]
    fn mono_is_measured_as_dual_mono() {
        // A mono file plays on both speakers, so it must read the same as the stereo equivalent.
        let audio = sine(48000, 1, &[(-23.0, 10.0)]);
        let r = analyze(&audio, 0, audio.frames(), false).unwrap();
        close(r.stats.integrated, -23.0, 0.1, "integrated");
    }

    #[test]
    fn tech3342_case1_loudness_range() {
        let audio = sine(48000, 2, &[(-20.0, 20.0), (-30.0, 20.0)]);
        let r = analyze(&audio, 0, audio.frames(), false).unwrap();
        close(r.stats.range, 10.0, 1.0, "LRA");
    }

    #[test]
    fn range_analysis_only_sees_the_range() {
        let audio = sine(48000, 2, &[(-20.0, 20.0), (-30.0, 20.0)]);
        let r = analyze(&audio, 0, 20 * 48000, false).unwrap();
        close(r.stats.integrated, -20.0, 0.1, "first half");
        let r = analyze(&audio, 20 * 48000, 40 * 48000, true).unwrap();
        close(r.stats.integrated, -30.0, 0.1, "second half");
        // Curves are positioned in absolute track time.
        assert!((r.curves.unwrap().momentary.t0 - 20.2).abs() < 1e-9);
    }

    #[test]
    fn true_peak_catches_intersample_overs() {
        // fs/4 sine at 45° phase: every sample lands at ±0.707·A, but the waveform peaks at A.
        let rate = 48000;
        let amp = 0.5;
        let data: Vec<f32> = (0..rate * 2)
            .map(|n| (amp * (PI / 2.0 * n as f64 + PI / 4.0).sin()) as f32)
            .collect();
        let audio = AudioData { sample_rate: rate, channels: vec![data.clone(), data] };
        let r = analyze(&audio, 0, audio.frames(), false).unwrap();
        close(r.stats.sample_peak, 20.0 * (amp * 0.5f64.sqrt()).log10(), 0.05, "sample peak");
        // EBU Tech 3341 true-peak tolerance is +0.2 / −0.4 dB.
        let tp = r.stats.true_peak.unwrap();
        let expected = 20.0 * amp.log10();
        assert!(tp > expected - 0.4 && tp < expected + 0.2, "true peak {tp:.2}, expected {expected:.2}");
        close(r.stats.plr, tp - r.stats.integrated.unwrap(), 1e-9, "PLR");
    }

    #[test]
    fn silence_is_undefined_not_minus_infinity() {
        let audio = AudioData { sample_rate: 48000, channels: vec![vec![0.0; 48000 * 5]; 2] };
        let r = analyze(&audio, 0, audio.frames(), true).unwrap();
        assert!(r.stats.integrated.is_none() && r.stats.range.is_none());
        assert!(r.stats.true_peak.is_none() && r.stats.plr.is_none());
        assert!(r.curves.unwrap().momentary.values.iter().all(|&v| v == -70.0));
    }
}

/// Timing on a real file: `SONIC_BENCH_FILE=song.flac cargo test bench_real_file -- --nocapture`.
#[test]
fn bench_real_file() {
    let Some(path) = std::env::var_os("SONIC_BENCH_FILE") else { return };
    let t = std::time::Instant::now();
    let audio = decode_file(std::path::Path::new(&path)).unwrap();
    let decode = t.elapsed();
    let t = std::time::Instant::now();
    compute_peaks(&audio, 8192);
    let peaks = t.elapsed();
    let t = std::time::Instant::now();
    let r = crate::loudness::analyze(&audio, 0, audio.frames(), true).unwrap();
    let loud = t.elapsed();
    let t = std::time::Instant::now();
    let d = crate::dynamics::analyze(&audio, 0, audio.frames(), &r.blocks, 0.0, true);
    let dynamics = t.elapsed();
    println!(
        "{:.0}s @ {} Hz: decode {decode:.2?}, peaks {peaks:.2?}, loudness {loud:.2?}, dynamics {dynamics:.2?}\n{:#?}\n{:#?}",
        audio.duration(),
        audio.sample_rate,
        r.stats,
        d.stats
    );
}

mod dynamics {
    use std::f64::consts::PI;

    use crate::decode::AudioData;
    use crate::dynamics::analyze;

    fn run(audio: &AudioData) -> crate::dynamics::DynamicsReport {
        let l = crate::loudness::analyze(audio, 0, audio.frames(), true).unwrap();
        analyze(audio, 0, audio.frames(), &l.blocks, 0.0, true)
    }

    fn stereo(data: Vec<f32>) -> AudioData {
        AudioData { sample_rate: 48000, channels: vec![data.clone(), data] }
    }

    fn sine_samples(db: f64, secs: f64) -> Vec<f32> {
        let amp = 10f64.powf(db / 20.0);
        (0..(secs * 48000.0) as usize)
            .map(|n| (amp * (2.0 * PI * 1000.0 * n as f64 / 48000.0).sin()) as f32)
            .collect()
    }

    fn close(actual: Option<f64>, expected: f64, tol: f64, what: &str) {
        let a = actual.unwrap_or_else(|| panic!("{what}: undefined"));
        assert!((a - expected).abs() <= tol, "{what}: {a:.3}, expected {expected} ±{tol}");
    }

    #[test]
    fn steady_sine_has_no_dynamics() {
        let r = run(&stereo(sine_samples(-23.0, 20.0)));
        // A sine's crest factor is √2 = 3.01 dB at any window length.
        close(r.stats.crest, 3.01, 0.05, "crest");
        close(r.stats.crest_short_median, 3.01, 0.05, "short crest");
        // TT DR scales RMS by √2 precisely so that a sine reads DR0.
        close(r.stats.dr, 0.0, 0.05, "DR");
        // A 1 kHz stereo sine: true peak (dBTP) equals its loudness (LUFS).
        close(r.stats.psr_median, 0.0, 0.2, "PSR median");
        assert_eq!(r.stats.onset_rate, Some(0.0));
        let total: f64 = r.short_term_histogram.fractions.iter().sum();
        assert!((total - 1.0).abs() < 1e-9);
        assert!(r.psr.unwrap().values.len() == 200 - 29);
    }

    #[test]
    fn two_level_percentiles() {
        let mut data = sine_samples(-20.0, 20.0);
        data.extend(sine_samples(-30.0, 20.0));
        let r = run(&stereo(data));
        close(r.stats.short_term_p95, -20.0, 0.2, "p95");
        close(r.stats.short_term_p10, -30.0, 0.2, "p10");
    }

    #[test]
    fn bursts_are_detected_as_onsets() {
        // 50 ms tone bursts at -6 dBFS every 500 ms over a -60 dBFS bed, for 10 s.
        let rate = 48000.0;
        let bed = 10f64.powf(-60.0 / 20.0);
        let burst = 10f64.powf(-6.0 / 20.0);
        let data: Vec<f32> = (0..(10.0 * rate) as usize)
            .map(|n| {
                let t = n as f64 / rate;
                let amp = if t % 0.5 < 0.05 { burst } else { bed };
                (amp * (2.0 * PI * 1000.0 * t).sin()) as f32
            })
            .collect();
        let r = run(&stereo(data));
        close(r.stats.onset_rate, 2.0, 0.15, "onset rate");
        // Rise is measured from the gate (loud level − 30 dB), not from the bed.
        assert!(r.stats.onset_rise.unwrap() > 20.0, "rise {:?}", r.stats.onset_rise);
        assert!(r.stats.crest.unwrap() > 8.0, "bursty material has a high crest factor");
    }

    #[test]
    fn silence_has_undefined_dynamics() {
        let r = run(&stereo(vec![0.0; 48000 * 5]));
        assert!(r.stats.crest.is_none() && r.stats.dr.is_none() && r.stats.psr_median.is_none());
        assert!(r.stats.short_term_p50.is_none());
    }
}

/// Dump a file's overview peaks and full analysis as JSON, e.g. for UI previews:
/// `SONIC_DUMP_FILE=song.flac SONIC_DUMP_JSON=out.json cargo test dump_analysis_json`.
#[test]
fn dump_analysis_json() {
    let (Some(input), Some(output)) = (std::env::var_os("SONIC_DUMP_FILE"), std::env::var_os("SONIC_DUMP_JSON"))
    else {
        return;
    };
    let audio = decode_file(std::path::Path::new(&input)).unwrap();
    let loudness = crate::loudness::analyze(&audio, 0, audio.frames(), true).unwrap();
    let dynamics = crate::dynamics::analyze(&audio, 0, audio.frames(), &loudness.blocks, 0.0, true);
    let t = std::time::Instant::now();
    let spectrum = crate::spectrum::analyze(&audio, 0, audio.frames(), loudness.stats.integrated);
    let stereo = crate::stereo::analyze(&audio, 0, audio.frames(), 0.0, true);
    println!("spectrum + stereo: {:.2?}", t.elapsed());
    let json = serde_json::json!({
        "name": std::path::Path::new(&input).file_name().unwrap().to_string_lossy(),
        "sampleRate": audio.sample_rate,
        "channels": audio.channels.len(),
        "duration": audio.duration(),
        "peaks": compute_peaks(&audio, 8192),
        "analysis": { "loudness": loudness, "dynamics": dynamics, "spectrum": spectrum, "stereo": stereo },
    });
    std::fs::write(output, json.to_string()).unwrap();
}

mod spectrum_and_stereo {
    use std::f64::consts::PI;

    use crate::decode::AudioData;
    use crate::spectrum;
    use crate::stereo;

    /// Deterministic white noise (xorshift), uniform in ±amp.
    pub(super) fn noise(seed: u64, len: usize, amp: f32) -> Vec<f32> {
        let mut x = seed;
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                ((x >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0) as f32 * amp
            })
            .collect()
    }

    fn audio(l: Vec<f32>, r: Vec<f32>) -> AudioData {
        AudioData { sample_rate: 48000, channels: vec![l, r] }
    }

    fn whole(a: &AudioData, integrated: Option<f64>) -> spectrum::SpectrumReport {
        spectrum::analyze(a, 0, a.frames(), integrated)
    }

    #[test]
    fn white_noise_rises_3db_per_octave() {
        // Energy per fractional-octave band doubles per octave for white noise; pink would be flat.
        let n = noise(1, 48000 * 10, 0.5);
        let r = whole(&audio(n.clone(), n), None);
        let tilt = r.tilt.unwrap();
        assert!((tilt - 3.01).abs() < 0.3, "tilt {tilt}");
    }

    #[test]
    fn band_energies_sum_to_signal_power() {
        // Uniform noise in ±a has power a²/3; 20 Hz–20 kHz holds ~19.98/24 of it at 48 kHz.
        let a = 0.5f64;
        let n = noise(2, 48000 * 10, a as f32);
        let r = whole(&audio(n.clone(), n), None);
        let total: f64 = r.bands.iter().map(|b| 10f64.powf(b.level.unwrap() / 10.0)).sum();
        let expected = a * a / 3.0 * (19980.0 / 24000.0);
        let err_db = 10.0 * (total / expected).log10();
        assert!(err_db.abs() < 0.2, "band sum off by {err_db:.2} dB");
    }

    #[test]
    fn loudness_normalisation_cancels_level() {
        let quiet = noise(3, 48000 * 6, 0.1);
        let loud: Vec<f32> = quiet.iter().map(|s| s * 4.0).collect();
        let lq = audio(quiet.clone(), quiet);
        let ll = audio(loud.clone(), loud);
        let iq = crate::loudness::analyze(&lq, 0, lq.frames(), false).unwrap().stats.integrated;
        let il = crate::loudness::analyze(&ll, 0, ll.frames(), false).unwrap().stats.integrated;
        let (a, b) = (whole(&lq, iq), whole(&ll, il));
        let worst = a.level.iter().zip(&b.level).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
        assert!(worst < 0.05, "normalised spectra differ by {worst} dB");
    }

    #[test]
    fn sine_peaks_at_its_frequency() {
        let s: Vec<f32> = (0..48000 * 5).map(|n| (0.5 * (2.0 * PI * 1000.0 * n as f64 / 48000.0).sin()) as f32).collect();
        let r = whole(&audio(s.clone(), s), None);
        let (i, _) = r.level.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap();
        assert!((r.freqs[i] / 1000.0).log2().abs() < 1.0 / 24.0, "peak at {} Hz", r.freqs[i]);
        assert!((r.centroid.unwrap() - 1000.0).abs() < 5.0);
    }

    #[test]
    fn identical_channels_are_mono_compatible_and_narrow() {
        let n = noise(4, 48000 * 5, 0.3);
        let a = audio(n.clone(), n);
        let st = stereo::analyze(&a, 0, a.frames(), 0.0, true);
        assert!((st.stats.correlation.unwrap() - 1.0).abs() < 1e-9);
        assert!(st.stats.side_to_mid.is_none(), "no side signal at all");
        assert_eq!(st.stats.negative_fraction, Some(0.0));
        let sp = whole(&a, None);
        assert!(sp.bands.iter().all(|b| b.width.unwrap() <= -59.9), "narrowest width is the floor");
    }

    #[test]
    fn inverted_and_independent_channels() {
        let n = noise(5, 48000 * 5, 0.3);
        let inverted: Vec<f32> = n.iter().map(|s| -s).collect();
        let a = audio(n.clone(), inverted);
        let st = stereo::analyze(&a, 0, a.frames(), 0.0, false);
        assert!((st.stats.correlation.unwrap() + 1.0).abs() < 1e-9);
        assert_eq!(st.stats.negative_fraction, Some(1.0));

        // Uncorrelated L/R: correlation ≈ 0 and side ≈ mid at every frequency.
        let a = audio(noise(6, 48000 * 10, 0.3), noise(7, 48000 * 10, 0.3));
        let st = stereo::analyze(&a, 0, a.frames(), 0.0, false);
        assert!(st.stats.correlation.unwrap().abs() < 0.02);
        assert!(st.stats.side_to_mid.unwrap().abs() < 0.1);
        let sp = whole(&a, None);
        for b in &sp.bands {
            assert!(b.width.unwrap().abs() < 1.0, "{} width {:?}", b.name, b.width);
        }
    }

    #[test]
    fn goniometer_is_normalised_and_mono_is_a_vertical_line() {
        let n = noise(8, 48000 * 2, 0.3);
        let a = audio(n.clone(), n);
        let st = stereo::analyze(&a, 0, a.frames(), 0.0, false);
        let size = st.goniometer_size;
        assert_eq!(st.goniometer.len(), size * size);
        assert_eq!(st.goniometer.iter().cloned().fold(0.0f32, f32::max), 1.0);
        // Side is always 0, so every point lands in the centre column.
        for (i, &v) in st.goniometer.iter().enumerate() {
            if v > 0.0 {
                assert_eq!(i % size, size / 2);
            }
        }
    }

    #[test]
    fn mono_file_reports_mono() {
        let n = noise(9, 48000 * 3, 0.3);
        let a = AudioData { sample_rate: 48000, channels: vec![n] };
        let st = stereo::analyze(&a, 0, a.frames(), 0.0, false);
        assert!(st.stats.mono);
        assert!(whole(&a, None).tilt.is_some());
    }
}

mod structure_and_activity {
    use std::f64::consts::PI;

    use super::spectrum_and_stereo::noise;
    use crate::decode::AudioData;
    use crate::{activity, sections, spectrogram};

    const RATE: u32 = 44100;

    fn tone(freq: f64, secs: f64, amp: f64) -> Vec<f32> {
        (0..(secs * RATE as f64) as usize)
            .map(|i| (amp * (2.0 * PI * freq * i as f64 / RATE as f64).sin()) as f32)
            .collect()
    }

    fn mono(samples: Vec<f32>) -> AudioData {
        AudioData { sample_rate: RATE, channels: vec![samples] }
    }

    #[test]
    fn spectrogram_shows_a_tone_in_its_row() {
        let a = mono(tone(1000.0, 4.0, 0.5));
        let (cols, rows) = (8, 64);
        let img = spectrogram::compute(&a, 0, a.frames(), cols, rows);
        assert_eq!(img.len(), cols * rows);
        // Row 0 is the top (highest frequency); find the brightest row of a middle column.
        let col = |c: usize| (0..rows).map(|r| img[r * cols + c]).collect::<Vec<u8>>();
        let mid = col(cols / 2);
        let brightest = (0..rows).max_by_key(|&r| mid[r]).unwrap();
        let ratio = (spectrogram::MAX_HZ / spectrogram::MIN_HZ).powf(1.0 / rows as f64);
        let (lo, hi) = {
            let band = rows - 1 - brightest;
            (spectrogram::MIN_HZ * ratio.powi(band as i32), spectrogram::MIN_HZ * ratio.powi(band as i32 + 1))
        };
        assert!(lo <= 1000.0 * 1.15 && hi >= 1000.0 / 1.15, "brightest row {lo:.0}–{hi:.0} Hz");
        // A −6 dBFS sine sits far above the floor; rows far from it are dark.
        assert!(mid[brightest] > 200, "{}", mid[brightest]);
        assert!(mid[0] < mid[brightest] / 2 && mid[rows - 1] < mid[brightest] / 2);
    }

    #[test]
    fn spectrogram_of_silence_is_black() {
        let a = mono(vec![0.0; RATE as usize * 2]);
        assert!(spectrogram::compute(&a, 0, a.frames(), 16, 16).iter().all(|&v| v == 0));
    }

    /// Quiet tone, loud noise, quiet tone again: an A B A song.
    fn aba() -> AudioData {
        let mut s = tone(220.0, 20.0, 0.1);
        s.extend(noise(7, 20 * RATE as usize, 0.4));
        s.extend(tone(220.0, 20.0, 0.1));
        mono(s)
    }

    #[test]
    fn sections_split_and_label_an_aba_form() {
        let a = aba();
        let s = sections::analyze(&a, 0, a.frames());
        assert_eq!(s.len(), 3, "{s:?}");
        assert!((s[1].start - 20.0).abs() < 1.5 && (s[2].start - 40.0).abs() < 1.5, "{s:?}");
        assert_eq!((s[0].label, s[1].label, s[2].label), (0, 1, 0));
        assert!(s[1].level > s[0].level + 6.0, "noise section is louder: {s:?}");
        assert_eq!(s[0].start, 0.0);
        assert!((s[2].end - 60.0).abs() < 1e-9);
    }

    #[test]
    fn short_or_steady_audio_is_one_section() {
        let a = mono(tone(440.0, 10.0, 0.3));
        let s = sections::analyze(&a, 0, a.frames());
        assert_eq!(s.len(), 1);
        let steady = mono(noise(3, 60 * RATE as usize, 0.3));
        assert_eq!(sections::analyze(&steady, 0, steady.frames()).len(), 1);
    }

    #[test]
    fn band_activity_puts_a_tone_in_one_band_and_gates_silence() {
        // Bands are half-octaves from 31.25 Hz, so 1189 Hz sits mid-band (1000–1414 Hz).
        let mut s = tone(1189.0, 6.0, 0.5);
        s.extend(vec![0.0; 3 * RATE as usize]);
        let a = mono(s);
        let r = activity::analyze(&a, 0, a.frames());
        assert_eq!(r.levels.len(), r.bands.len());
        let band = r.bands.iter().position(|b| (b[0]..b[1]).contains(&1189.0)).unwrap();
        // Mid-tone: nearly all of the moment's energy is in the tone's band.
        let c = 4;
        let level = r.levels[band][c].unwrap();
        assert!(level > -1.0 && level < 0.5, "{level}");
        let other = r.levels[0][c].unwrap();
        assert!(other < -40.0, "{other}");
        // The silent tail has no readings.
        assert!(r.levels[band].last().unwrap().is_none());
        assert!((r.t0 - 0.25).abs() < 1e-9 && r.hop == activity::CELL_SECONDS);
    }
}

mod eq {
    use crate::eq::{Filter, FilterKind, suggest};
    use crate::spectrum::grid;

    #[test]
    fn biquads_match_their_analog_prototypes() {
        let rate = 48000.0;
        for f in [
            Filter { kind: FilterKind::Peak, freq: 1000.0, gain: 4.0, q: 1.0 },
            Filter { kind: FilterKind::Peak, freq: 80.0, gain: -3.0, q: 0.7 },
            Filter { kind: FilterKind::LowShelf, freq: 200.0, gain: -3.0, q: 0.707 },
            Filter { kind: FilterKind::HighShelf, freq: 3000.0, gain: 2.5, q: 0.707 },
        ] {
            let bq = f.biquad(rate);
            // The bilinear transform warps frequencies near Nyquist; compare where it doesn't.
            for hz in [30.0, 100.0, 300.0, 1000.0, 2000.0, 4000.0] {
                let (digital, analog) = (bq.response_db(hz, rate), f.response_db(hz));
                assert!((digital - analog).abs() < 0.25, "{f:?} at {hz} Hz: {digital:.2} vs {analog:.2}");
            }
        }
    }

    /// A "reference" that is the flat track plus the given filters.
    fn shaped(filters: &[Filter]) -> (Vec<f64>, Vec<f32>, Vec<f32>) {
        let freqs = grid();
        let track = vec![-20.0f32; freqs.len()];
        let reference = freqs
            .iter()
            .map(|&f| -20.0 + filters.iter().map(|x| x.response_db(f)).sum::<f64>() as f32)
            .collect();
        (freqs, track, reference)
    }

    #[test]
    fn filter_prototypes_hit_their_gain() {
        let peak = Filter { kind: FilterKind::Peak, freq: 1000.0, gain: 4.0, q: 1.0 };
        assert!((peak.response_db(1000.0) - 4.0).abs() < 1e-9);
        assert!(peak.response_db(20.0).abs() < 0.05 && peak.response_db(20000.0).abs() < 0.05);
        let low = Filter { kind: FilterKind::LowShelf, freq: 200.0, gain: -3.0, q: 0.707 };
        assert!((low.response_db(10.0) + 3.0).abs() < 0.05 && low.response_db(10000.0).abs() < 0.05);
        assert!((low.response_db(200.0) + 1.5).abs() < 0.05, "shelf is half-gain at its corner");
        let high = Filter { kind: FilterKind::HighShelf, freq: 5000.0, gain: 2.0, q: 0.707 };
        assert!((high.response_db(20000.0) - 2.0).abs() < 0.1 && high.response_db(100.0).abs() < 0.05);
    }

    #[test]
    fn identical_spectra_need_no_eq() {
        let (freqs, track, _) = shaped(&[]);
        let r = suggest(&freqs, &track, &track);
        assert!(r.suggestions.is_empty());
        assert!(r.error_before < 1e-9);
    }

    #[test]
    fn level_difference_is_not_eq() {
        let (freqs, track, _) = shaped(&[]);
        let louder: Vec<f32> = track.iter().map(|v| v + 5.0).collect();
        let r = suggest(&freqs, &track, &louder);
        assert!(r.suggestions.is_empty(), "{:?}", r.suggestions);
        assert!((r.offset - 5.0).abs() < 1e-6);
    }

    #[test]
    fn recovers_a_presence_boost() {
        let (freqs, track, reference) = shaped(&[Filter { kind: FilterKind::Peak, freq: 3000.0, gain: 4.0, q: 1.0 }]);
        let r = suggest(&freqs, &track, &reference);
        let first = r.suggestions[0];
        assert_eq!(first.kind, FilterKind::Peak);
        assert!((first.freq / 3000.0).log2().abs() < 0.25, "freq {}", first.freq);
        // Smoothing and offset removal shave a little off the apparent gain.
        assert!(first.gain > 2.5 && first.gain < 5.0, "gain {}", first.gain);
        assert!(r.error_after < 0.35 * r.error_before, "{} -> {}", r.error_before, r.error_after);
    }

    #[test]
    fn recovers_a_darker_top_end_as_a_shelf() {
        let (freqs, track, reference) =
            shaped(&[Filter { kind: FilterKind::HighShelf, freq: 6000.0, gain: -4.0, q: 0.707 }]);
        let r = suggest(&freqs, &track, &reference);
        let shelf = r.suggestions.iter().find(|f| f.kind == FilterKind::HighShelf).expect("a high shelf");
        assert!(shelf.gain < -2.0, "gain {}", shelf.gain);
        assert!(r.error_after < 0.35 * r.error_before);
    }

    #[test]
    fn two_moves_two_suggestions() {
        let (freqs, track, reference) = shaped(&[
            Filter { kind: FilterKind::LowShelf, freq: 120.0, gain: 4.0, q: 0.707 },
            Filter { kind: FilterKind::Peak, freq: 400.0, gain: -4.0, q: 1.4 },
        ]);
        let r = suggest(&freqs, &track, &reference);
        assert!(r.suggestions.len() >= 2 && r.suggestions.len() <= 4, "{:?}", r.suggestions);
        assert!(r.suggestions.iter().any(|f| f.gain > 0.0 && f.freq < 250.0));
        assert!(r.suggestions.iter().any(|f| f.gain < 0.0 && (250.0..700.0).contains(&f.freq)));
        assert!(r.error_after < 0.5);
    }
}

/// EQ suggestions for a real pair: `SONIC_EQ_TRACK=a.flac SONIC_EQ_REFERENCE=b.flac cargo test eq_real_pair -- --nocapture`.
#[test]
fn eq_real_pair() {
    let (Some(a), Some(b)) = (std::env::var_os("SONIC_EQ_TRACK"), std::env::var_os("SONIC_EQ_REFERENCE")) else {
        return;
    };
    let spectrum = |p: &std::ffi::OsStr| {
        let audio = decode_file(std::path::Path::new(p)).unwrap();
        let l = crate::loudness::analyze(&audio, 0, audio.frames(), false).unwrap();
        crate::spectrum::analyze(&audio, 0, audio.frames(), l.stats.integrated)
    };
    let (sa, sb) = (spectrum(&a), spectrum(&b));
    let t = std::time::Instant::now();
    let r = crate::eq::suggest(&sa.freqs, &sa.level, &sb.level);
    println!("suggest: {:.2?}, offset {:.2} dB, error {:.2} -> {:.2} dB", t.elapsed(), r.offset, r.error_before, r.error_after);
    for f in &r.suggestions {
        println!("  {:?} {} Hz {:+.1} dB Q {}", f.kind, f.freq, f.gain, f.q);
    }
    if let Some(out) = std::env::var_os("SONIC_EQ_JSON") {
        std::fs::write(out, serde_json::to_string(&r).unwrap()).unwrap();
    }
}

/// Index a real folder and print the best matches for its first track.
/// Set `SONIC_LIBRARY_DIR` to a folder of audio files (a few albums is plenty).
#[test]
fn library_real_folder() {
    use crate::library::Library;
    let Some(root) = std::env::var_os("SONIC_LIBRARY_DIR") else { return };
    let db = std::env::temp_dir().join(format!("sonic-library-test-{}.json", std::process::id()));
    let lib = Library::new(PathBuf::from(&root), db.clone());
    let t = std::time::Instant::now();
    lib.index(&|_| {});
    let status = lib.status();
    println!("indexed {} ({} failed) in {:.1?}", status.indexed, status.failed, t.elapsed());
    assert!(status.error.is_none(), "{:?}", status.error);
    assert!(status.indexed > 0);

    // A second run finds nothing new.
    lib.index(&|_| {});
    assert_eq!(lib.status().queued, 0);

    // Reloading from disk keeps everything, and a track's best match is itself.
    let lib = Library::new(PathBuf::from(&root), db.clone());
    assert_eq!(lib.status().indexed, status.indexed);
    let first = lib.similar(&crate::similarity::Features { tonal: vec![], dynamics: vec![], stereo: vec![] }, &[], [1.0; 3], 1);
    assert!(first.is_empty(), "no shared values means no match");
    let path = lib.paths().into_iter().min().unwrap();
    let audio = decode_file(std::path::Path::new(&path)).unwrap();
    let report = crate::analyze_range(&audio, 0, audio.frames(), false).unwrap();
    let matches = lib.similar(&report.features, &[], [0.5, 0.3, 0.2], 5);
    for m in &matches {
        println!("{:5.1}  t{:5.1} d{:5.1} s{:5.1}  {}", m.score, m.tonal.unwrap_or(0.0), m.dynamics.unwrap_or(0.0), m.stereo.unwrap_or(0.0), m.track.rel_path);
    }
    assert_eq!(matches[0].track.path, path);
    // Searching for the file name finds it.
    let name = std::path::Path::new(&path).file_stem().unwrap().to_string_lossy().to_uppercase();
    assert!(lib.search(&name, 50).iter().any(|t| t.path == path), "search {name}");
    assert!(matches[0].score > 99.0);
    let _ = std::fs::remove_file(db);
}

/// Sections, band activity and spectrogram timings for a real file:
/// `SONIC_SECTIONS_FILE=song.flac cargo test sections_real_file -- --nocapture`.
#[test]
fn sections_real_file() {
    let Some(path) = std::env::var_os("SONIC_SECTIONS_FILE") else { return };
    let audio = decode_file(std::path::Path::new(&path)).unwrap();
    let t = std::time::Instant::now();
    let sections = crate::sections::analyze(&audio, 0, audio.frames());
    println!("sections: {:.2?}", t.elapsed());
    for s in &sections {
        let label = (b'A' + s.label as u8) as char;
        println!("  {label}  {:6.1}–{:6.1} s  {:+.1} dB", s.start, s.end, s.level);
    }
    let t = std::time::Instant::now();
    crate::activity::analyze(&audio, 0, audio.frames());
    println!("band activity: {:.2?}", t.elapsed());
    let t = std::time::Instant::now();
    crate::spectrogram::compute(&audio, 0, audio.frames(), 1600, 200);
    println!("spectrogram 1600×200: {:.2?}", t.elapsed());
}

/// Starts Deemix headless in a temporary data folder, connects and searches Deezer (no login,
/// no download): `SONIC_DEEMIX_SEARCH="artist title" cargo test deemix_search -- --nocapture`.
#[test]
fn deemix_search() {
    let Some(query) = std::env::var_os("SONIC_DEEMIX_SEARCH") else { return };
    let dir = std::env::temp_dir().join("abnormal-deemix-test");
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    let deemix = crate::deemix::Deemix::new(&home, dir.join("data"), dir.join("music"));
    let status = deemix.connect().unwrap();
    println!("{status:?}");
    assert!(status.installed);
    let tracks = deemix.search(&query.to_string_lossy(), 5).unwrap();
    for t in &tracks {
        println!("{:>10} {} - {} ({}, album {}) {:.0} s", t.id, t.artist, t.title, t.album, t.album_id, t.duration);
    }
    assert!(!tracks.is_empty());
    assert!(deemix.queue().unwrap().is_empty());
    deemix.shutdown();
    let _ = std::fs::remove_dir_all(dir);
}

/// Sets up the song-structure environment (if needed) and analyses files, exactly as the app
/// does: `SONIC_STRUCTURE_FILE=a.flac[:b.flac…] [SONIC_STRUCTURE_ROOT=dir] cargo test
/// structure_real_file -- --nocapture`. Several files are queued at once, so their stages
/// overlap (stems of the next while the model runs on the previous). Without a root, a
/// temporary one is used (slow: full install).
#[test]
fn structure_real_file() {
    let Some(files) = std::env::var_os("SONIC_STRUCTURE_FILE") else { return };
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    let root = std::env::var_os("SONIC_STRUCTURE_ROOT").map_or_else(|| std::env::temp_dir().join("abnormal-structure-test"), PathBuf::from);
    let engine = std::sync::Arc::new(crate::structure::Engine::new(home, root));
    let t = std::time::Instant::now();
    engine.install(&|s| println!("setup: {s:?}"));
    let status = engine.status();
    assert!(status.installed, "install failed: {:?}", status.error);
    println!("setup took {:.0?}", t.elapsed());

    let paths: Vec<PathBuf> = std::env::split_paths(&files).collect();
    let (tx, rx) = std::sync::mpsc::channel();
    let t = std::time::Instant::now();
    for path in &paths {
        let tx = tx.clone();
        engine.request(path.clone(), std::sync::Arc::new(move |o| tx.send(o.clone()).unwrap()));
    }
    for _ in &paths {
        let outcome = rx.recv().unwrap();
        println!("{} done after {:.0?}", outcome.path, t.elapsed());
        let s = outcome.structure.unwrap_or_else(|| panic!("{:?}", outcome.error));
        println!("bpm {:?}, {} beats, {} bars", s.bpm, s.beats.len(), s.downbeats.len());
        for seg in &s.segments {
            println!("  {:6.1}–{:6.1}  {}", seg.start, seg.end, seg.label);
        }
        assert!(!s.segments.is_empty());
        assert!(engine.cached(std::path::Path::new(&outcome.path)).is_some(), "result should be cached");
    }
}
