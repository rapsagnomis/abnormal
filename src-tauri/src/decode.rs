use std::fs::File;
use std::path::Path;

use anyhow::{Context, Result, anyhow, bail};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

/// Decoded audio at its original sample rate, one `Vec` per channel.
/// This is the source of truth for analysis; playback uses a resampled copy.
pub struct AudioData {
    pub sample_rate: u32,
    pub channels: Vec<Vec<f32>>,
}

impl AudioData {
    pub fn frames(&self) -> usize {
        self.channels.first().map_or(0, Vec::len)
    }

    pub fn duration(&self) -> f64 {
        self.frames() as f64 / self.sample_rate as f64
    }
}

pub fn decode_file(path: &Path) -> Result<AudioData> {
    let file = File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .context("unsupported or corrupt audio file")?;

    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| anyhow!("no audio track found"))?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| anyhow!("track has no audio codec parameters"))?
        .clone();

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .context("no decoder for this codec")?;

    let mut sample_rate = params.sample_rate.unwrap_or(0);
    let mut channels: Vec<Vec<f32>> = Vec::new();
    let mut interleaved: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            // Truncated files commonly end with an unexpected EOF; keep what we have.
            Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                break;
            }
            Err(e) => return Err(e).context("error reading audio packets"),
        };
        if packet.track_id != track_id {
            continue;
        }

        let buf = match decoder.decode(&packet) {
            Ok(buf) => buf,
            // A corrupt frame is skipped rather than failing the whole file.
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(e).context("decode failed"),
        };

        let spec = buf.spec();
        let n_ch = spec.channels().count();
        if channels.is_empty() {
            sample_rate = spec.rate();
            channels = vec![Vec::new(); n_ch];
        }
        if n_ch != channels.len() {
            bail!("channel count changed mid-stream ({} -> {n_ch})", channels.len());
        }

        buf.copy_to_vec_interleaved(&mut interleaved);
        for frame in interleaved.chunks_exact(n_ch) {
            for (ch, &s) in channels.iter_mut().zip(frame) {
                ch.push(s);
            }
        }
    }

    if channels.is_empty() || channels[0].is_empty() || sample_rate == 0 {
        bail!("file contains no decodable audio");
    }
    Ok(AudioData { sample_rate, channels })
}
