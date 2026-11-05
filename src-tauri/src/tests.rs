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

#[test]
fn cover_accent_picks_the_vivid_dominant_hue() {
    use crate::accent::accent_of;
    let hue_of = |hex: &str| {
        let c: Vec<u8> = (0..3).map(|i| u8::from_str_radix(&hex[1 + 2 * i..3 + 2 * i], 16).unwrap()).collect();
        (c[0], c[1], c[2])
    };
    // Mostly grey with a red patch: the red, lifted to a bright tone.
    let mut px = vec![[120u8, 120, 120]; 900];
    px.extend(vec![[150u8, 20, 20]; 100]);
    let (r, g, b) = hue_of(&accent_of(px.into_iter()).unwrap());
    assert!(r > 190 && g < 110 && b < 110, "red accent, got {r},{g},{b}");
    // A dull dominant brown and a vivid secondary blue: the blue (brighter, more saturated).
    let mut px = vec![[110u8, 80, 50]; 600];
    px.extend(vec![[30u8, 90, 240]; 300]);
    let (r, _, b) = hue_of(&accent_of(px.into_iter()).unwrap());
    assert!(b > r + 60, "blue accent, got {r},_,{b}");
    // Black and white: no colour.
    let px = (0..1000).map(|i| if i % 2 == 0 { [0u8, 0, 0] } else { [255u8, 255, 255] });
    assert!(accent_of(px).is_none());
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
    let psycho = crate::psycho::analyze(&audio, 0, audio.frames(), crate::loudness::analyze(&audio, 0, audio.frames(), false).unwrap().stats.integrated);
    println!("psychoacoustics {psycho:.2?} in {:.2?}", t.elapsed());
    let t = std::time::Instant::now();
    let id = crate::decode::audio_id(&audio);
    println!("audio id {id} in {:.2?}", t.elapsed());
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

/// Player mode in the mixer (`player::Mixer`), without an audio device.
mod player_mode {
    use std::sync::Arc;

    use crate::decode::AudioData;
    use crate::player::{Mixer, PlaybackBuffer, Shared};

    const RATE: u32 = 48000;

    /// A constant-level mono track: its level tells which track is heard.
    fn track(level: f32, frames: usize) -> PlaybackBuffer {
        PlaybackBuffer::new(&AudioData { sample_rate: RATE, channels: vec![vec![level; frames]] }, RATE).unwrap()
    }

    #[test]
    fn plays_tracks_one_after_another() {
        let shared = Arc::new(Shared::new());
        shared.device_rate.store(RATE, std::sync::atomic::Ordering::Relaxed);
        // A (0.1, 0.75 s), an empty lane, then C in slot 5 (0.3); B (0.2) is left out of the order.
        shared.set_track(0, Some(track(0.1, RATE as usize * 3 / 4)));
        shared.set_track(1, Some(track(0.2, RATE as usize)));
        shared.set_track(5, Some(track(0.3, RATE as usize / 2)));
        shared.set_player_mode(true, &[0, 2, 5]);
        shared.set_active(0);
        shared.set_playing(true);
        let mut mixer = Mixer::new(shared.clone(), 1, RATE);

        let mut out = vec![0.0f32; RATE as usize / 2];
        mixer.render(&mut out);
        let t = shared.transport();
        // Halfway through A: B (not in the order) and C (not heard) haven't moved.
        assert_eq!(t.active, 0);
        assert!((t.positions[0] - 0.5).abs() < 1e-3 && t.positions[1] == 0.0 && t.positions[5] == 0.0, "{:?}", t.positions);
        assert!((out[out.len() - 1] - 0.1).abs() < 1e-4);

        // A ends 0.25 s later: C takes over from its start, skipping the empty lane.
        mixer.render(&mut out);
        let t = shared.transport();
        assert_eq!(t.active, 5);
        assert!((t.positions[5] - 0.25).abs() < 1e-3, "{:?}", t.positions);
        assert!((out[out.len() - 1] - 0.3).abs() < 1e-3, "{}", out[out.len() - 1]);

        // C is the last: playback stops when it ends.
        mixer.render(&mut out);
        mixer.render(&mut out);
        assert!(!shared.transport().playing);
    }

    /// Replacing a playing track (another version) crossfades from the old one, which carries on
    /// from where it was: no jump at the swap, the new level within `SWAP_SECONDS`.
    #[test]
    fn replacing_a_playing_track_crossfades() {
        let shared = Arc::new(Shared::new());
        shared.device_rate.store(RATE, std::sync::atomic::Ordering::Relaxed);
        shared.set_track(0, Some(track(0.1, RATE as usize)));
        shared.set_playing(true);
        let mut mixer = Mixer::new(shared.clone(), 1, RATE);
        let mut out = vec![0.0f32; RATE as usize / 4];
        mixer.render(&mut out);
        assert!((out[out.len() - 1] - 0.1).abs() < 1e-4);

        shared.set_shared_track(0, Some(Arc::new(track(0.3, RATE as usize))), 0.25);
        let mut out = vec![0.0f32; RATE as usize / 10];
        mixer.render(&mut out);
        // From the old level, rising smoothly (at most one fade step a sample), to the new one.
        assert!((out[0] - 0.1).abs() < 0.01, "starts at the old level: {}", out[0]);
        let step = 0.2 / (0.06 * RATE as f32);
        assert!(out.windows(2).all(|w| (w[1] - w[0]).abs() <= step * 1.01 + 1e-6), "no jump");
        assert!((out[out.len() - 1] - 0.3).abs() < 1e-4, "ends at the new level: {}", out[out.len() - 1]);
        assert!((shared.transport().positions[0] - 0.35).abs() < 1e-3, "the new one plays from the swap time");
    }

    #[test]
    fn without_player_mode_tracks_move_together() {
        let shared = Arc::new(Shared::new());
        shared.device_rate.store(RATE, std::sync::atomic::Ordering::Relaxed);
        shared.set_track(0, Some(track(0.1, RATE as usize)));
        shared.set_track(1, Some(track(0.2, RATE as usize)));
        shared.set_playing(true);
        let mut mixer = Mixer::new(shared.clone(), 1, RATE);
        mixer.render(&mut vec![0.0f32; RATE as usize / 4]);
        let t = shared.transport();
        assert!((t.positions[0] - 0.25).abs() < 1e-3 && (t.positions[1] - 0.25).abs() < 1e-3);
    }
}

/// Psychoacoustic models against their references: ISO 532-1 test signals for loudness, the
/// definition of 1 acum for sharpness, and Daniel & Weber's reference sound for 1 asper.
mod psychoacoustics {
    use std::f64::consts::PI;

    use crate::psycho::{RoughnessModel, loudness, sharpness, third_octave_levels_of};

    const FS: f64 = 48000.0;

    fn close(value: f64, expected: f64, rtol: f64, atol: f64) -> bool {
        (value - expected).abs() <= atol + rtol * expected.abs()
    }

    /// A sine at `db` SPL (RMS), in pascals.
    fn tone(freq: f64, db: f64, secs: f64) -> Vec<f64> {
        let amp = 2e-5 * 10f64.powf(db / 20.0) * 2f64.sqrt();
        (0..(secs * FS) as usize).map(|i| amp * (2.0 * PI * freq * i as f64 / FS).sin()).collect()
    }

    /// ISO 532-1 annex B, test signal 1: given 1/3-octave levels (free field).
    #[test]
    fn iso_test_signal_1_loudness() {
        let levels = [
            -60.0, -60.0, 78.0, 79.0, 89.0, 72.0, 80.0, 89.0, 75.0, 87.0, 85.0, 79.0, 86.0, 80.0, 71.0, 70.0, 72.0, 71.0, 72.0, 74.0,
            69.0, 65.0, 67.0, 77.0, 68.0, 58.0, 45.0, 30.0,
        ];
        let (n, specific) = loudness(&levels);
        assert!(close(n, 83.296, 0.05, 0.1), "N = {n:.3} sone");
        // Specific loudness at a few points of the standard's table (sone/Bark, every 2 Bark).
        let iso = [(0, 5.3272), (20, 7.5599), (40, 6.4327), (60, 3.6218), (80, 2.5232), (100, 2.3498), (120, 2.5533), (140, 2.737), (160, 2.281), (180, 2.6301), (200, 3.3234), (220, 1.3555)];
        for (k, expected) in iso {
            assert!(close(specific[k], expected, 0.05, 0.1), "N'({:.1}) = {:.4}, ISO {expected}", (k + 1) as f64 * 0.1, specific[k]);
        }
    }

    /// ISO 532-1 test signal 3: 1 kHz at 60 dB, 4.019 sone; and loudness doubling per +10 dB.
    #[test]
    fn one_khz_tone_loudness() {
        let (n, specific) = loudness(&third_octave_levels_of(&tone(1000.0, 60.0, 1.0), FS));
        assert!(close(n, 4.019, 0.05, 0.1), "N = {n:.3} sone");
        assert!(close(specific[80], 1.2273, 0.05, 0.1), "N'(8.1) = {:.4}", specific[80]);
        let (n70, _) = loudness(&third_octave_levels_of(&tone(1000.0, 70.0, 1.0), FS));
        assert!((n70 / n - 2.0).abs() < 0.2, "{n70:.2} vs {n:.2}");
    }

    /// Deterministic noise in pascals with a flat spectrum between `lo` and `hi` Hz, at `db` SPL:
    /// sines on every 1 Hz with pseudo-random phases.
    fn band_noise(lo: f64, hi: f64, db: f64, secs: f64) -> Vec<f64> {
        let len = (secs * FS) as usize;
        let mut out = vec![0.0; len];
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut f = lo.ceil();
        while f <= hi {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let phase = (seed % 10_000) as f64 / 10_000.0 * 2.0 * PI;
            for (i, o) in out.iter_mut().enumerate() {
                *o += (2.0 * PI * f * i as f64 / FS + phase).sin();
            }
            f += 1.0;
        }
        let rms = (out.iter().map(|v| v * v).sum::<f64>() / len as f64).sqrt();
        let target = 2e-5 * 10f64.powf(db / 20.0);
        out.iter().map(|v| v * target / rms).collect()
    }

    /// DIN 45692 defines 1 acum as critical-band-wide noise at 1 kHz, 60 dB; higher bands are sharper.
    #[test]
    fn sharpness_of_reference_noise_is_one_acum() {
        let measure = |lo, hi| {
            let (n, specific) = loudness(&third_octave_levels_of(&band_noise(lo, hi, 60.0, 1.0), FS));
            sharpness(n, &specific).unwrap()
        };
        let reference = measure(920.0, 1080.0);
        assert!(close(reference, 1.0, 0.08, 0.0), "S = {reference:.3} acum");
        let high = measure(4000.0, 4800.0);
        let low = measure(150.0, 250.0);
        assert!(high > 2.0 * reference && low < 0.6 * reference, "low {low:.2}, ref {reference:.2}, high {high:.2}");
    }

    /// Daniel & Weber: 1 kHz, 100 % amplitude-modulated at 70 Hz, 60 dB is 1 asper (±17 %, as
    /// MoSQITo's compliance test); the same tone unmodulated is hardly rough at all.
    #[test]
    fn roughness_of_reference_tone_is_one_asper() {
        let len = (0.2 * FS) as usize;
        let am: Vec<f64> = (0..len)
            .map(|i| {
                let t = i as f64 / FS;
                (1.0 + (2.0 * PI * 70.0 * t).sin()) * (2.0 * PI * 1000.0 * t).sin()
            })
            .collect();
        let rms = (am.iter().map(|v| v * v).sum::<f64>() / len as f64).sqrt();
        let am: Vec<f64> = am.iter().map(|v| v * 2e-5 * 1000.0 / rms).collect();
        let model = RoughnessModel::new(len, FS);
        let r = model.roughness(&am);
        assert!((0.83..=1.17).contains(&r), "R = {r:.3} asper");
        let plain = model.roughness(&tone(1000.0, 60.0, 0.2));
        assert!(plain < 0.1, "unmodulated R = {plain:.3}");
    }
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

mod activity_and_spectrogram {
    use std::f64::consts::PI;

    use crate::decode::AudioData;
    use crate::{activity, spectrogram};

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
    use std::f64::consts::PI;

    use super::spectrum_and_stereo::noise;
    use crate::decode::AudioData;
    use crate::eq::{Filter, FilterKind, Placement, match_eq, suggest};
    use crate::fir;
    use crate::spectrum::{MidSide, grid, mid_side};

    #[test]
    fn biquads_match_their_analog_prototypes() {
        let rate = 48000.0;
        for f in [
            Filter::stereo(FilterKind::Peak, 1000.0, 4.0, 1.0),
            Filter::stereo(FilterKind::Peak, 80.0, -3.0, 0.7),
            Filter::stereo(FilterKind::LowShelf, 200.0, -3.0, 0.707),
            Filter::stereo(FilterKind::HighShelf, 3000.0, 2.5, 0.707),
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
        let peak = Filter::stereo(FilterKind::Peak, 1000.0, 4.0, 1.0);
        assert!((peak.response_db(1000.0) - 4.0).abs() < 1e-9);
        assert!(peak.response_db(20.0).abs() < 0.05 && peak.response_db(20000.0).abs() < 0.05);
        let low = Filter::stereo(FilterKind::LowShelf, 200.0, -3.0, 0.707);
        assert!((low.response_db(10.0) + 3.0).abs() < 0.05 && low.response_db(10000.0).abs() < 0.05);
        assert!((low.response_db(200.0) + 1.5).abs() < 0.05, "shelf is half-gain at its corner");
        let high = Filter::stereo(FilterKind::HighShelf, 5000.0, 2.0, 0.707);
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
        let (freqs, track, reference) = shaped(&[Filter::stereo(FilterKind::Peak, 3000.0, 4.0, 1.0)]);
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
            shaped(&[Filter::stereo(FilterKind::HighShelf, 6000.0, -4.0, 0.707)]);
        let r = suggest(&freqs, &track, &reference);
        let shelf = r.suggestions.iter().find(|f| f.kind == FilterKind::HighShelf).expect("a high shelf");
        assert!(shelf.gain < -2.0, "gain {}", shelf.gain);
        assert!(r.error_after < 0.35 * r.error_before);
    }

    #[test]
    fn two_moves_two_suggestions() {
        let (freqs, track, reference) = shaped(&[
            Filter::stereo(FilterKind::LowShelf, 120.0, 4.0, 0.707),
            Filter::stereo(FilterKind::Peak, 400.0, -4.0, 1.4),
        ]);
        let r = suggest(&freqs, &track, &reference);
        assert!(r.suggestions.len() >= 2 && r.suggestions.len() <= 4, "{:?}", r.suggestions);
        assert!(r.suggestions.iter().any(|f| f.gain > 0.0 && f.freq < 250.0));
        assert!(r.suggestions.iter().any(|f| f.gain < 0.0 && (250.0..700.0).contains(&f.freq)));
        assert!(r.error_after < 0.5);
    }

    /// Mid/side spectra: flat mid at -20 dB, side `side_db` below it plus `side_filters`.
    fn mid_side_of(side_db: f64, side_filters: &[Filter]) -> MidSide {
        let freqs = grid();
        MidSide {
            mid: vec![-20.0; freqs.len()],
            side: freqs.iter().map(|&f| -20.0 + side_db + side_filters.iter().map(|x| x.response_db(f)).sum::<f64>()).collect(),
            mono: false,
        }
    }

    #[test]
    fn wider_reference_is_a_width_change_not_eq() {
        let r = match_eq(&grid(), &mid_side_of(-10.0, &[]), &mid_side_of(-7.0, &[]));
        assert!(r.stereo.suggestions.is_empty(), "{:?}", r.stereo.suggestions);
        let side = r.side.expect("stereo tracks get a side report");
        let width = side.width.expect("a width change");
        assert_eq!(width.placement, Placement::Side);
        // +3 dB of side, less the loudness the extra side adds (matched away as level offset).
        assert!(width.gain > 2.0 && width.gain < 3.0, "width {}", width.gain);
        assert!(side.suggestions.is_empty(), "{:?}", side.suggestions);
    }

    #[test]
    fn side_only_difference_gets_a_side_move() {
        let bump = [Filter::stereo(FilterKind::Peak, 3000.0, 4.0, 1.0)];
        let r = match_eq(&grid(), &mid_side_of(-8.0, &[]), &mid_side_of(-8.0, &bump));
        let side = r.side.unwrap();
        let first = side.suggestions.first().expect("a side move");
        assert_eq!(first.placement, Placement::Side);
        assert!(first.gain > 2.0 && (first.freq / 3000.0).log2().abs() < 0.3, "{first:?}");
        assert!(side.error_after < 0.5 * side.error_before, "{} -> {}", side.error_before, side.error_after);
    }

    #[test]
    fn mono_tracks_get_no_side_report() {
        let mono = MidSide { mono: true, ..mid_side_of(-60.0, &[]) };
        let r = match_eq(&grid(), &mono, &mid_side_of(-10.0, &[]));
        assert!(r.side.is_none());
        assert_eq!(r.full.side, r.full.mid);
    }

    #[test]
    fn full_match_follows_the_difference() {
        let freqs = grid();
        let boost = Filter::stereo(FilterKind::Peak, 3000.0, 4.0, 1.0);
        let reference = MidSide {
            mid: freqs.iter().map(|&f| -20.0 + boost.response_db(f)).collect(),
            ..mid_side_of(-10.0, &[boost])
        };
        let r = match_eq(&freqs, &mid_side_of(-10.0, &[]), &reference);
        let at = |v: &[f32], hz: f64| v[freqs.iter().position(|&f| f >= hz).unwrap()] as f64;
        // Local-linear smoothing over 3/8 octave rounds the top of the bell a little.
        assert!((at(&r.full.total, 3000.0) - 4.0).abs() < 0.75, "{}", at(&r.full.total, 3000.0));
        // Away from the bell only the removed level offset is left.
        let offset = r.stereo.offset;
        assert!((at(&r.full.mid, 100.0) + offset).abs() < 0.3 && (at(&r.full.side, 15000.0) + offset).abs() < 0.3);
        // One bell matches a one-bell difference closely.
        assert!(r.full.gap < 0.6, "gap {}", r.full.gap);
    }

    #[test]
    fn loudest_parts_ignore_the_quiet_ones() {
        let rate = 48000;
        let tone = |freq: f64, amp: f64, secs: f64| -> Vec<f32> {
            (0..(secs * rate as f64) as usize).map(|i| (amp * (2.0 * PI * freq * i as f64 / rate as f64).sin()) as f32).collect()
        };
        // 48 s loud 1 kHz, then 12 s of 100 Hz 10 dB quieter (above the -20 dB frame gate): the
        // range splits into five 12 s pieces, the last one quiet.
        let mut samples = tone(1000.0, 0.5, 48.0);
        samples.extend(tone(100.0, 0.16, 12.0));
        let audio = AudioData { sample_rate: rate, channels: vec![samples.clone(), samples] };
        let at = |m: &MidSide, hz: f64| m.mid[grid().iter().position(|&f| f >= hz).unwrap()];
        let all = mid_side(&audio, 0, audio.frames(), false).unwrap();
        let loud = mid_side(&audio, 0, audio.frames(), true).unwrap();
        assert!(at(&all, 100.0) > at(&all, 1000.0) - 25.0);
        assert!(at(&loud, 100.0) < at(&loud, 1000.0) - 40.0, "{} vs {}", at(&loud, 100.0), at(&loud, 1000.0));
    }

    #[test]
    fn flat_fir_passes_audio_unchanged_and_side_gain_scales_the_side() {
        let (l, r) = (noise(3, 20000, 0.5), noise(4, 20000, 0.5));
        let stereo: Vec<f32> = l.iter().zip(&r).flat_map(|(&a, &b)| [a, b]).collect();
        let freqs = grid();
        let n = fir::taps_for(48000.0);
        let flat = fir::design(&freqs, &vec![0.0; freqs.len()], 48000.0, n);
        let out = fir::filter_mid_side(&stereo, &flat, &flat);
        assert_eq!(out.len(), stereo.len());
        assert!(out.iter().zip(&stereo).all(|(a, b)| (a - b).abs() < 1e-4));

        let double = fir::design(&freqs, &vec![6.0206; freqs.len()], 48000.0, n);
        let wide = fir::filter_mid_side(&stereo, &flat, &double);
        for (o, i) in wide.chunks(2).zip(stereo.chunks(2)).skip(100).take(1000) {
            let (m, s) = ((i[0] + i[1]) / 2.0, (i[0] - i[1]) / 2.0);
            assert!((o[0] - (m + 2.0 * s)).abs() < 1e-3 && (o[1] - (m - 2.0 * s)).abs() < 1e-3);
        }
    }

    #[test]
    fn fir_follows_a_shelf() {
        let rate = 48000.0;
        let freqs = grid();
        let shelf = Filter::stereo(FilterKind::HighShelf, 2000.0, 6.0, 0.707);
        let curve: Vec<f32> = freqs.iter().map(|&f| shelf.response_db(f) as f32).collect();
        let n = fir::taps_for(rate);
        let h = fir::design(&freqs, &curve, rate, n);
        let gain_db = |hz: f64| {
            let len = 48000;
            let x: Vec<f32> = (0..len).flat_map(|i| {
                let v = (2.0 * PI * hz * i as f64 / rate).sin() as f32 * 0.25;
                [v, v]
            }).collect();
            let y = fir::filter_mid_side(&x, &h, &h);
            let rms = |v: &[f32]| (v.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / v.len() as f64).sqrt();
            let mid = len / 4 * 2..len * 3 / 4 * 2;
            20.0 * (rms(&y[mid.clone()]) / rms(&x[mid])).log10()
        };
        for hz in [100.0, 1000.0, 2000.0, 8000.0] {
            let (got, want) = (gain_db(hz), shelf.response_db(hz));
            assert!((got - want).abs() < 0.3, "{hz} Hz: {got:.2} vs {want:.2}");
        }
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
    for loudest in [false, true] {
        let mid_side = |p: &std::ffi::OsStr| {
            let audio = decode_file(std::path::Path::new(p)).unwrap();
            crate::spectrum::mid_side(&audio, 0, audio.frames(), loudest).unwrap()
        };
        let t = std::time::Instant::now();
        let m = crate::eq::match_eq(&crate::spectrum::grid(), &mid_side(&a), &mid_side(&b));
        println!("match_eq (loudest {loudest}): {:.2?}, full-match gap {:.2} dB", t.elapsed(), m.full.gap);
        for f in &m.stereo.suggestions {
            println!("  stereo {:?} {} Hz {:+.1} dB Q {}", f.kind, f.freq, f.gain, f.q);
        }
        if let Some(side) = &m.side {
            println!("  side: error {:.2} -> {:.2} dB, gap {:.2?}", side.error_before, side.error_after, m.full.side_gap);
            for f in side.width.iter().chain(&side.suggestions) {
                println!("  side {:?} {} Hz {:+.1} dB Q {}", f.kind, f.freq, f.gain, f.q);
            }
        }
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
    let lib = Library::new(Some(PathBuf::from(&root)), db.clone());
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
    let lib = Library::new(Some(PathBuf::from(&root)), db.clone());
    assert_eq!(lib.status().indexed, status.indexed);
    let first = lib.similar(&crate::similarity::Features { tonal: vec![], dynamics: vec![], stereo: vec![] }, &[], [1.0; 3], 1);
    assert!(first.is_empty(), "no shared values means no match");
    let path = lib.paths().into_iter().min().unwrap();
    let audio = decode_file(std::path::Path::new(&path)).unwrap();
    let report = crate::analyze_range(&audio, 0, audio.frames(), false, true).unwrap();
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

/// Band activity and spectrogram timings for a real file:
/// `SONIC_SECTIONS_FILE=song.flac cargo test sections_real_file -- --nocapture`.
#[test]
fn sections_real_file() {
    let Some(path) = std::env::var_os("SONIC_SECTIONS_FILE") else { return };
    let audio = decode_file(std::path::Path::new(&path)).unwrap();
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
    let deemix = crate::deemix::Deemix::new(&home, dir.join("data"), Some(dir.join("music")));
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

/// Markers follow the audio: a move keeps them, copies share them, a re-bounce over the same path
/// carries them over, the first (path-keyed) format migrates, markers without a note aren't saved,
/// and an empty list removes them.
#[test]
fn markers_follow_the_audio() {
    use crate::markers::{Marker, Markers};
    let db = std::env::temp_dir().join(format!("abnormal-markers-{}.json", std::process::id()));
    let m = |time: f64, note: &str| Marker { time, note: note.into() };
    let notes = vec![m(3.5, "intro"), m(42.0, "harsh vocal")];

    let store = Markers::new(db.clone());
    store.set("mix-v1", "/old/mix.wav", vec![m(42.0, "harsh vocal"), m(10.0, "  "), m(3.5, "intro"), m(20.0, "")]).unwrap();
    // Reloaded from disk, sorted; moved to another folder: same audio, same notes.
    let store = Markers::new(db.clone());
    assert_eq!(store.get("mix-v1", "/new/mix.wav"), notes);
    // A file with the same audio but no shared path gets nothing; an unrelated one neither.
    assert!(store.get("other", "/elsewhere.wav").is_empty());
    // Re-bounced over /new/mix.wav (new audio): carried over, and the copy at /old keeps them too.
    assert_eq!(store.get("mix-v2", "/new/mix.wav"), notes);
    assert_eq!(store.get("mix-v1", "/old/mix.wav"), notes);
    // Re-bounced again over its only path: moved, not left behind.
    store.set("mix-v2", "/new/mix.wav", vec![m(1.0, "v2")]).unwrap();
    assert_eq!(store.get("mix-v3", "/new/mix.wav"), vec![m(1.0, "v2")]);
    assert!(!std::fs::read_to_string(&db).unwrap().contains("mix-v2"));
    // Clearing removes the entry.
    store.set("mix-v3", "/new/mix.wav", vec![]).unwrap();
    assert!(Markers::new(db.clone()).get("mix-v3", "/new/mix.wav").is_empty());

    // First format, keyed by path: claimed by the audio found there.
    std::fs::write(&db, r#"{"/a.flac":[{"time":2.0,"note":"intro"}]}"#).unwrap();
    let store = Markers::new(db.clone());
    assert_eq!(store.get("a", "/a.flac"), vec![m(2.0, "intro")]);
    assert_eq!(Markers::new(db.clone()).get("a", "/moved/a.flac"), vec![m(2.0, "intro")]);
    let _ = std::fs::remove_file(db);
}

/// Sessions keep their lanes in order with their versions, names, front version and loudness
/// matching, find the
/// files again when their folder moves, still open the first (flat) format, and the recent list
/// puts the last used first without duplicates.
#[test]
fn sessions_round_trip() {
    use crate::sessions::{self, Lane, Recents};
    let root = std::env::temp_dir().join(format!("abnormal-sessions-{}", std::process::id()));
    let album = root.join("album");
    std::fs::create_dir_all(&album).unwrap();
    let at = |dir: &std::path::Path, n: &str| dir.join(n).to_string_lossy().into_owned();
    for n in ["2 b v1.wav", "2 b v2.wav", "1 a.wav", "3 c.wav", "ref x.flac", "ref y.flac", "default ref.flac"] {
        std::fs::write(album.join(n), b"").unwrap();
    }
    let lanes = vec![
        Lane {
            name: "Song B".into(),
            versions: vec![at(&album, "2 b v1.wav"), at(&album, "2 b v2.wav")],
            front: 1,
            match_loudness: true,
            references: vec![at(&album, "ref x.flac"), at(&album, "ref y.flac")],
            reference_front: 1,
            compare_default: true,
            color: Some("#e05186".into()),
            ..Lane::default()
        },
        // Compared with lane 3, which becomes lane 2 once the empty lane is left out.
        Lane { versions: vec![at(&album, "1 a.wav")], compare_lane: Some(3), ..Lane::default() },
        Lane { name: "empty".into(), ..Lane::default() },
        // Compared with the empty lane: the link goes with it.
        Lane { versions: vec![at(&album, "3 c.wav")], compare_lane: Some(2), ..Lane::default() },
    ];
    let file = album.join("Album.abnormal");
    let default_ref = at(&album, "default ref.flac");
    let saved = sessions::write(&file, &lanes, Some(&default_ref)).unwrap();
    assert_eq!(saved.name, "Album");
    let read = sessions::read(&file).unwrap();
    assert_eq!(
        read.lanes,
        [
            lanes[0].clone(),
            Lane { compare_lane: Some(2), ..lanes[1].clone() },
            Lane { compare_lane: None, ..lanes[3].clone() },
        ]
    );
    assert_eq!(read.default_reference.as_deref(), Some(default_ref.as_str()));

    // The album folder moved: files are found next to the session.
    let moved = root.join("moved");
    std::fs::rename(&album, &moved).unwrap();
    let opened = sessions::read(&moved.join("Album.abnormal")).unwrap();
    assert_eq!(opened.lanes[0].versions, [at(&moved, "2 b v1.wav"), at(&moved, "2 b v2.wav")]);
    assert_eq!((opened.lanes[0].name.as_str(), opened.lanes[0].front, opened.lanes[0].match_loudness), ("Song B", 1, true));
    // The song's references moved with it.
    assert_eq!(opened.lanes[0].references, [at(&moved, "ref x.flac"), at(&moved, "ref y.flac")]);
    assert_eq!(opened.lanes[0].reference_front, 1);
    assert_eq!(opened.default_reference, Some(at(&moved, "default ref.flac")));

    // The first format: a flat list of tracks, one version per lane.
    let v1 = moved.join("Old.abnormal");
    let a = at(&moved, "1 a.wav");
    std::fs::write(&v1, format!(r#"{{"version":1,"tracks":[{{"path":{a:?}}}]}}"#)).unwrap();
    assert_eq!(sessions::read(&v1).unwrap().lanes, [Lane { versions: vec![a], ..Lane::default() }]);

    let recents = Recents::new(root.join("recent.json"));
    recents.touch(&opened);
    recents.touch(&saved); // its file is gone: remembered, but not listed
    recents.touch(&opened);
    let list = Recents::new(root.join("recent.json")).list();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].name.as_str(), list[0].tracks), ("Album", 3));
    let _ = std::fs::remove_dir_all(root);
}

/// Files renamed or moved outside the app are found again: by bookmark (macOS) wherever they went
/// on the volume, else by identity (size and edge hash) in the folders around where they were;
/// a different file of the same size isn't taken for them, and a file found nowhere keeps its path.
#[test]
fn sessions_find_renamed_files() {
    use crate::relink;
    use crate::sessions::{self, Lane};
    // Canonical, as bookmarks resolve to it (the temp folder is under a symlink on macOS).
    let root = std::env::temp_dir().canonicalize().unwrap().join(format!("abnormal-relink-{}", std::process::id()));
    let album = root.join("album");
    std::fs::create_dir_all(&album).unwrap();
    let at = |dir: &std::path::Path, n: &str| dir.join(n).to_string_lossy().into_owned();
    // Same size, different contents (past the hashed edges too).
    let audio = |c: u8| (0..300_000u32).map(|i| (i % 251) as u8 ^ c).collect::<Vec<u8>>();
    for (i, n) in ["mix v1.wav", "mix v2.wav", "gone.wav"].iter().enumerate() {
        std::fs::write(album.join(n), audio(i as u8 + 1)).unwrap();
    }
    assert_ne!(relink::identity(&album.join("mix v1.wav")), relink::identity(&album.join("mix v2.wav")));
    let lane = |versions: Vec<String>| Lane { versions, ..Lane::default() };
    let file = album.join("Album.abnormal");
    sessions::write(&file, &[lane(vec![at(&album, "mix v1.wav"), at(&album, "mix v2.wav")]), lane(vec![at(&album, "gone.wav")])], None).unwrap();

    // v1 renamed in place, v2 moved three folders away (out of reach of the search), gone deleted.
    std::fs::rename(album.join("mix v1.wav"), album.join("mix v1 final.wav")).unwrap();
    let far = root.join("elsewhere/a/b");
    std::fs::create_dir_all(&far).unwrap();
    std::fs::rename(album.join("mix v2.wav"), far.join("v2.wav")).unwrap();
    std::fs::remove_file(album.join("gone.wav")).unwrap();
    let opened = sessions::read(&file).unwrap();
    assert_eq!(opened.lanes[0].versions[0], at(&album, "mix v1 final.wav"));
    assert_eq!(opened.lanes[1].versions, [at(&album, "gone.wav")]);
    if cfg!(target_os = "macos") {
        assert_eq!(opened.lanes[0].versions[1], at(&far, "v2.wav"));
        assert_eq!(opened.relinked.len(), 2);
    }

    // Without bookmarks (another platform, an older session): the identity search alone, which
    // finds the rename next to it but not the file moved out of reach.
    let mut json: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    for lane in json["lanes"].as_array_mut().unwrap() {
        for t in lane["versions"].as_array_mut().unwrap() {
            t.as_object_mut().unwrap().remove("bookmark");
        }
    }
    std::fs::write(&file, serde_json::to_vec(&json).unwrap()).unwrap();
    let opened = sessions::read(&file).unwrap();
    assert_eq!(opened.lanes[0].versions, [at(&album, "mix v1 final.wav"), at(&album, "mix v2.wav")]);
    assert_eq!(opened.relinked, [sessions::Relinked { from: at(&album, "mix v1.wav"), to: at(&album, "mix v1 final.wav") }]);
    let _ = std::fs::remove_dir_all(root);
}

/// Prepared versions: wanted files are prepared in order, kept until no longer wanted, found by
/// the slot playing them, with their loudness, and prepared again when the file changes (a re-bounce).
#[test]
fn prepared_versions_follow_the_files() {
    use crate::decode::AudioData;
    use crate::prepared::{Decoded, Prepared, stamp_of};
    use std::sync::Arc;
    let dir = std::env::temp_dir().join(format!("abnormal-prepared-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = |n: &str| dir.join(n).to_string_lossy().into_owned();
    let (v1, v2) = (file("v1.wav"), file("v2.wav"));
    std::fs::write(&v1, b"one").unwrap();
    std::fs::write(&v2, b"two").unwrap();
    let stamp = |p: &str| stamp_of(std::path::Path::new(p)).unwrap();
    let decoded = |tag: &'static str| Decoded { audio: Arc::new(AudioData { sample_rate: 48000, channels: vec![vec![0.0; 480]] }), buffer: None, info: tag };

    let prepared = Prepared::<&str>::new();
    prepared.want(vec![v1.clone(), v2.clone()]);
    assert_eq!(prepared.next().map(|n| n.0), Some(v1.clone()));
    let report = r#"{"loudness":{"stats":{"integrated":-9.5}}}"#;
    prepared.keep(&v1, stamp(&v1), Some(&decoded("v1")), Some(report.into()));
    assert_eq!(prepared.next().map(|n| n.0), Some(v2.clone()));
    assert_eq!(prepared.loudness(&[v1.clone(), v2.clone()]), [Some(-9.5), None]);
    assert_eq!(prepared.decoded(&v1).map(|d| d.info), Some("v1"));
    assert_eq!(prepared.ready(), [v1.clone()]);

    // A slot playing v1 finds its analysis.
    prepared.set_slot(3, Some((v1.clone(), stamp(&v1))));
    assert_eq!(prepared.slot_report(3).as_deref(), Some(report));

    // Re-bounced over the same file (different size): prepared again.
    std::fs::write(&v1, b"one, louder").unwrap();
    assert!(prepared.decoded(&v1).is_none());
    assert_eq!(prepared.loudness(&[v1.clone()]), [None]);
    assert_eq!(prepared.next().map(|n| n.0), Some(v1.clone()));

    // No longer wanted: dropped, and not kept when offered.
    prepared.want(vec![v2.clone()]);
    prepared.keep(&v1, stamp(&v1), Some(&decoded("v1")), None);
    assert!(prepared.decoded(&v1).is_none());
    let _ = std::fs::remove_dir_all(dir);
}

/// Library standing: percentiles (ties count half), quantiles, and values read off fingerprints.
#[test]
fn library_standing_percentiles() {
    use crate::similarity::Features;
    use crate::standing::{Input, standings};
    // A fingerprint with a flat tonal shape except `bright` dB above 2.5 kHz, and PLR `plr`.
    let fp = |bright: f32, plr: f32| Features {
        tonal: (0..28).map(|i| Some(if 20.0 * 2f64.powf((16 + 8 * i) as f64 / 24.0) >= 2500.0 { bright } else { 0.0 })).collect(),
        dynamics: vec![Some(6.0), Some(plr), Some(9.0), Some(12.0), Some(8.0), Some(2.0), Some(10.0)],
        stereo: vec![Some(0.8); 8],
    };
    let library: Vec<Features> = (0..10).map(|i| fp(i as f32, 5.0 + i as f32)).collect();
    let population: Vec<(&Features, Option<f64>)> = library.iter().enumerate().map(|(i, f)| (f, Some(-14.0 + i as f64))).collect();
    let mix = Input { features: fp(7.5, 2.0), integrated: Some(-20.0) };
    let reference = Input { features: fp(4.0, 9.0), integrated: Some(-10.0) };
    let out = standings(&[Some(mix), Some(reference), None], &population);

    let get = |key: &str| out.iter().find(|s| s.key == key).unwrap();
    let bright = get("brightness");
    assert_eq!(bright.count, 10);
    assert_eq!(bright.quantiles.len(), 21);
    assert!((bright.quantiles[0] - 0.0).abs() < 1e-9 && (bright.quantiles[20] - 9.0).abs() < 1e-9);
    assert!((bright.values[0].unwrap() - 7.5).abs() < 1e-6);
    assert!((bright.percentiles[0].unwrap() - 80.0).abs() < 1e-9, "{:?}", bright.percentiles); // 8 of 10 below
    assert!((bright.percentiles[1].unwrap() - 45.0).abs() < 1e-9, "{:?}", bright.percentiles); // 4 below, 1 tie
    assert_eq!(bright.percentiles[2], None);
    // The mix: more limited and quieter than the whole library; the reference mid-pack.
    assert_eq!(get("plr").percentiles[0], Some(0.0));
    assert_eq!(get("loudness").percentiles[0], Some(0.0));
    assert_eq!(get("loudness").percentiles[1], Some(45.0));
    // Constant over the library: still listed, every value tied.
    assert_eq!(get("punch").percentiles[0], Some(50.0));
}

mod bundle {
    use std::f64::consts::PI;
    use std::io::Read;

    use crate::bundle::{BundleItem, Format, archive_names, load_cover, write_zip};
    use crate::decode::{AudioData, decode_file, read_tags};
    use crate::wav::write_wav_to;

    #[test]
    fn names_are_safe_and_unique() {
        let item = |name: &str| BundleItem { source: String::new(), name: name.into(), title: String::new() };
        let names = archive_names(&[item("01 - A/B: mix"), item("Song"), item("song"), item("  ")], Format::Flac);
        assert_eq!(names, ["01 - A_B_ mix.flac", "Song.flac", "song (2).flac", "Untitled.flac"]);
    }

    /// MP3 can't carry 96 or 88.2 kHz: such sources are resampled (to 48 and 44.1 kHz), keeping
    /// their length and level; rates MP3 takes are left alone.
    #[test]
    fn high_resolution_mp3_is_resampled() {
        use crate::bundle::resampled_for_mp3;
        for (rate, expected) in [(96_000u32, 48_000u32), (88_200, 44_100)] {
            let sine: Vec<f32> = (0..rate).map(|i| (0.5 * (2.0 * PI * 1000.0 * i as f64 / rate as f64).sin()) as f32).collect();
            let audio = AudioData { sample_rate: rate, channels: vec![sine.clone(), sine.clone(), sine] };
            let out = resampled_for_mp3(&audio).unwrap().unwrap();
            assert_eq!((out.sample_rate, out.channels.len()), (expected, 2));
            assert!((out.frames() as i64 - expected as i64).abs() < 64, "{} frames", out.frames());
            let mid = &out.channels[0][out.frames() / 4..out.frames() * 3 / 4];
            let peak = mid.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            assert!((peak - 0.5).abs() < 0.01, "peak {peak}");
        }
        let cd = AudioData { sample_rate: 44_100, channels: vec![vec![0.0; 100]] };
        assert!(resampled_for_mp3(&cd).unwrap().is_none());
    }

    /// Two sine tracks zipped in each format: both come back, decodable, at about the same
    /// level and length, tagged; the cover is in the archive and embedded in FLAC and MP3.
    #[test]
    fn zip_round_trip() {
        let dir = std::env::temp_dir().join(format!("abnormal-zip-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rate = 44_100;
        let tone = |hz: f64| -> Vec<f32> { (0..rate * 2).map(|i| (0.5 * (2.0 * PI * hz * i as f64 / rate as f64).sin()) as f32).collect() };
        let mut sources = Vec::new();
        for (n, hz) in [(1, 440.0), (2, 1000.0)] {
            let audio = AudioData { sample_rate: rate as u32, channels: vec![tone(hz), tone(hz)] };
            let path = dir.join(format!("source {n}.wav"));
            let mut bytes = Vec::new();
            write_wav_to(&mut bytes, &audio, false, &[]).unwrap();
            std::fs::write(&path, bytes).unwrap();
            sources.push(path);
        }
        let items: Vec<BundleItem> = sources
            .iter()
            .enumerate()
            .map(|(i, p)| BundleItem { source: p.display().to_string(), name: format!("0{} - Ünïcode {}", i + 1, i + 1), title: format!("Ünïcode {}", i + 1) })
            .collect();
        let cover_path = dir.join("art.png");
        image::RgbImage::from_fn(32, 24, |x, y| image::Rgb([x as u8 * 8, y as u8 * 10, 128])).save(&cover_path).unwrap();
        let cover = load_cover(&cover_path).unwrap();
        assert_eq!((cover.mime, cover.width, cover.height), ("image/png", 32, 24));

        for format in [Format::Wav, Format::Flac, Format::Mp3] {
            let ext = match format {
                Format::Wav => "wav",
                Format::Flac => "flac",
                Format::Mp3 => "mp3",
            };
            let zip_path = dir.join(format!("bundle-{ext}.zip"));
            write_zip(&zip_path, &items, format, "Artist", "Album", Some(&cover), |_| {}).unwrap();
            let mut archive = zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();
            assert_eq!(archive.len(), 3);
            let mut art = Vec::new();
            archive.by_name("cover.png").unwrap().read_to_end(&mut art).unwrap();
            assert_eq!(art, cover.data);
            for (i, item) in items.iter().enumerate() {
                let name = format!("{}.{ext}", item.name);
                let mut bytes = Vec::new();
                archive.by_name(&name).unwrap().read_to_end(&mut bytes).unwrap();
                let out = dir.join(&name);
                std::fs::write(&out, bytes).unwrap();
                let audio = decode_file(&out).unwrap();
                assert_eq!(audio.channels.len(), 2, "{name}");
                // MP3 adds encoder delay and padding.
                assert!((audio.duration() - 2.0).abs() < 0.1, "{name}: {} s", audio.duration());
                let mid = &audio.channels[0][rate / 2..rate];
                let peak = mid.iter().fold(0f32, |m, s| m.max(s.abs()));
                assert!((peak - 0.5).abs() < 0.02, "{name}: peak {peak}");
                let title = format!("Ünïcode {}", i + 1);
                if format == Format::Wav {
                    // Symphonia 0.6 reads a WAV's INFO chunk but drops it: look for the tags.
                    let bytes = std::fs::read(&out).unwrap();
                    let has = |id: &[u8], v: &str| bytes.windows(8 + v.len()).any(|w| &w[..4] == id && &w[8..] == v.as_bytes());
                    assert!(has(b"INAM", &title) && has(b"IART", "Artist") && has(b"IPRD", "Album"), "{name}");
                } else {
                    let tags = read_tags(&out).unwrap();
                    assert_eq!(tags.title.as_deref(), Some(title.as_str()), "{name}");
                    assert_eq!(tags.artist.as_deref(), Some("Artist"), "{name}");
                    assert_eq!(tags.album.as_deref(), Some("Album"), "{name}");
                    assert_eq!(tags.cover.as_deref(), Some(cover.data.as_slice()), "{name}: cover");
                    // An audio file's own cover can be picked as the cover too.
                    assert_eq!(load_cover(&out).unwrap().data, cover.data, "{name}");
                }
            }
        }
        if std::env::var_os("SONIC_KEEP_ZIP").is_none() {
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }
}
