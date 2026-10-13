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
    fn noise(seed: u64, len: usize, amp: f32) -> Vec<f32> {
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

mod eq {
    use crate::eq::{Filter, FilterKind, suggest};
    use crate::spectrum::grid;

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
