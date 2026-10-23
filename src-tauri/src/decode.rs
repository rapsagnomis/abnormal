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

/// Identity of the audio itself, not the file: SHA-256 over the sample rate, channel count and
/// decoded samples (first 128 bits, hex). Moving, renaming or retagging a file keeps it; any change
/// to the sound gives a new one. Lossy files depend on the decoder's exact output.
pub fn audio_id(audio: &AudioData) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(audio.sample_rate.to_le_bytes());
    hash.update((audio.channels.len() as u32).to_le_bytes());
    let mut bytes = Vec::with_capacity(1 << 16);
    for channel in &audio.channels {
        for chunk in channel.chunks(1 << 14) {
            bytes.clear();
            bytes.extend(chunk.iter().flat_map(|s| s.to_bits().to_le_bytes()));
            hash.update(&bytes);
        }
    }
    hash.finalize()[..16].iter().map(|b| format!("{b:02x}")).collect()
}

/// Title, artist, album and embedded cover from a file's tags (ID3, Vorbis comments, …).
#[derive(Default, Debug)]
pub struct Tags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// Encoded image bytes (JPEG/PNG), preferring the front cover.
    pub cover: Option<Box<[u8]>>,
}

/// Read tags only: the file is probed, no audio is decoded. Every metadata revision is looked at
/// (e.g. ID3v2 at the start and ID3v1 at the end of an mp3); the first value found wins.
pub fn read_tags(path: &Path) -> Result<Tags> {
    use symphonia::core::meta::{StandardTag, StandardVisualKey};

    let file = File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .context("unsupported or corrupt audio file")?;

    let mut tags = Tags::default();
    let mut front_cover = false;
    let mut metadata = format.metadata();
    loop {
        if let Some(rev) = metadata.current() {
            for tag in &rev.media.tags {
                let (slot, value) = match &tag.std {
                    Some(StandardTag::TrackTitle(v)) => (&mut tags.title, v),
                    Some(StandardTag::Artist(v)) => (&mut tags.artist, v),
                    Some(StandardTag::Album(v)) => (&mut tags.album, v),
                    _ => continue,
                };
                let value = value.trim();
                if slot.is_none() && !value.is_empty() {
                    *slot = Some(value.to_owned());
                }
            }
            for visual in &rev.media.visuals {
                let is_front = visual.usage == Some(StandardVisualKey::FrontCover);
                if !visual.data.is_empty() && (tags.cover.is_none() || (is_front && !front_cover)) {
                    tags.cover = Some(visual.data.clone());
                    front_cover = is_front;
                }
            }
        }
        if metadata.pop().is_none() {
            break;
        }
    }
    Ok(tags)
}
