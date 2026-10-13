//! EBU R128 / ITU BS.1770-4 loudness measurement.

use anyhow::Result;
use ebur128::{Channel, EbuR128, Mode};
use serde::Serialize;

use crate::decode::AudioData;

/// Curve resolution: one loudness reading per 100 ms block, as defined by BS.1770.
pub const HOP_SECONDS: f64 = 0.1;
const MOMENTARY_SECONDS: f64 = 0.4;
const SHORT_TERM_SECONDS: f64 = 3.0;
/// Floor for curve values so silence serialises as a number rather than -inf.
const CURVE_FLOOR: f32 = -70.0;

/// Summary statistics. `None` means the value is undefined (silence, or the range is too short
/// for the measurement window).
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessStats {
    /// Integrated (gated) loudness, LUFS.
    pub integrated: Option<f64>,
    /// Loudness range, LU.
    pub range: Option<f64>,
    pub momentary_max: Option<f64>,
    pub short_term_max: Option<f64>,
    /// Max over channels, dBFS.
    pub sample_peak: Option<f64>,
    /// Max over channels, dBTP (4× oversampled below 96 kHz).
    pub true_peak: Option<f64>,
    /// Peak-to-loudness ratio: true peak − integrated, LU.
    pub plr: Option<f64>,
}

/// Loudness over time. Each value is centred on its measurement window, so point `i` sits at
/// `t0 + i * hop` seconds — directly comparable to the waveform at that time.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Curve {
    pub t0: f64,
    pub hop: f64,
    pub values: Vec<f32>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessCurves {
    pub momentary: Curve,
    pub short_term: Curve,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessReport {
    pub stats: LoudnessStats,
    pub curves: Option<LoudnessCurves>,
    /// Per-block data reused by the dynamics analysis; not sent to the UI.
    #[serde(skip)]
    pub blocks: Blocks,
}

/// One entry per whole 100 ms block of the analysed range.
#[derive(Debug, Default)]
pub struct Blocks {
    /// Short-term loudness ending at this block, LUFS (NaN until the 3 s window is full).
    pub short_term: Vec<f64>,
    /// True peak within this block, max over channels, linear.
    pub true_peak: Vec<f64>,
}

fn finite(v: f64) -> Option<f64> {
    v.is_finite().then_some(v)
}

fn to_db(linear: f64) -> Option<f64> {
    finite(20.0 * linear.log10())
}

/// Measure frames `start..end` of `audio`.
pub fn analyze(audio: &AudioData, start: usize, end: usize, with_curves: bool) -> Result<LoudnessReport> {
    let end = end.min(audio.frames());
    let start = start.min(end);
    let rate = audio.sample_rate;
    let n_ch = audio.channels.len() as u32;

    let mut meter = EbuR128::new(
        n_ch,
        rate,
        Mode::I | Mode::LRA | Mode::M | Mode::S | Mode::SAMPLE_PEAK | Mode::TRUE_PEAK,
    )?;
    // A mono file is played on both speakers, so measure it as dual mono (+3 dB vs. one speaker),
    // matching how it is heard and how most meters treat mono material.
    if n_ch == 1 {
        meter.set_channel(0, Channel::DualMono)?;
    }

    let hop = (rate as f64 * HOP_SECONDS).round() as usize;
    let blocks_per_m = (MOMENTARY_SECONDS / HOP_SECONDS).round() as usize;
    let blocks_per_s = (SHORT_TERM_SECONDS / HOP_SECONDS).round() as usize;
    let mut momentary = Vec::new();
    let mut short_term = Vec::new();
    let (mut m_max, mut s_max) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
    let mut blocks = Blocks::default();

    let mut block = 0usize;
    let mut pos = start;
    while pos < end {
        let next = (pos + hop).min(end);
        let planes: Vec<&[f32]> = audio.channels.iter().map(|c| &c[pos..next]).collect();
        meter.add_frames_planar_f32(&planes)?;
        // A trailing partial block still counts towards integrated loudness and peaks, but
        // momentary/short-term readings are only taken on whole-block boundaries.
        if next - pos < hop {
            break;
        }
        pos = next;
        block += 1;

        let mut tp = 0.0f64;
        for ch in 0..n_ch {
            tp = tp.max(meter.prev_true_peak(ch)?);
        }
        blocks.true_peak.push(tp);
        blocks.short_term.push(f64::NAN);

        // Readings are only meaningful once their window has been filled.
        if block >= blocks_per_m {
            let m = meter.loudness_momentary()?;
            m_max = m_max.max(m);
            if with_curves {
                momentary.push((m as f32).max(CURVE_FLOOR));
            }
        }
        if block >= blocks_per_s {
            let s = meter.loudness_shortterm()?;
            s_max = s_max.max(s);
            *blocks.short_term.last_mut().unwrap() = s;
            if with_curves {
                short_term.push((s as f32).max(CURVE_FLOOR));
            }
        }
    }

    let peak_over = |f: &dyn Fn(u32) -> Result<f64, ebur128::Error>| -> Result<f64> {
        let mut m = 0.0f64;
        for ch in 0..n_ch {
            m = m.max(f(ch)?);
        }
        Ok(m)
    };
    let sample_peak = to_db(peak_over(&|c| meter.sample_peak(c))?);
    let true_peak = to_db(peak_over(&|c| meter.true_peak(c))?);
    let integrated = finite(meter.loudness_global()?);
    // LRA is undefined until enough short-term blocks pass the gate; ebur128 reports 0 then.
    let range = finite(meter.loudness_range()?).filter(|_| integrated.is_some());

    let stats = LoudnessStats {
        integrated,
        range,
        momentary_max: finite(m_max),
        short_term_max: finite(s_max),
        sample_peak,
        true_peak,
        plr: true_peak.zip(integrated).map(|(tp, i)| tp - i),
    };

    let start_s = start as f64 / rate as f64;
    let curves = with_curves.then(|| LoudnessCurves {
        momentary: Curve {
            t0: start_s + MOMENTARY_SECONDS / 2.0,
            hop: HOP_SECONDS,
            values: momentary,
        },
        short_term: Curve {
            t0: start_s + SHORT_TERM_SECONDS / 2.0,
            hop: HOP_SECONDS,
            values: short_term,
        },
    });

    Ok(LoudnessReport { stats, curves, blocks })
}
