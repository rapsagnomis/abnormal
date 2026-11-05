//! Export as Zip: the version in front of each lane, written into one zip archive as WAV
//! (24-bit), FLAC (24-bit) or MP3 (320 kb/s CBR), tagged with its title, the artist, the
//! album (the archive's name) and its track number.
//!
//! Each file is decoded and encoded from the source, except an MP3 exported as MP3: its frames
//! are copied as they are (no second lossy generation) and only its tags are replaced.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::decode::{self, AudioData};
use crate::wav;

/// Files encoded at once (each holds a decoded track in memory).
const WORKERS: usize = 4;

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Wav,
    Flac,
    Mp3,
}

impl Format {
    fn extension(self) -> &'static str {
        match self {
            Format::Wav => "wav",
            Format::Flac => "flac",
            Format::Mp3 => "mp3",
        }
    }
}

/// One track of the archive.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleItem {
    /// The audio file.
    pub source: String,
    /// Its file name in the archive, without extension.
    pub name: String,
    pub title: String,
}

struct Tags<'a> {
    title: &'a str,
    artist: &'a str,
    album: &'a str,
    track: usize,
    total: usize,
}

/// Write `items` (in track order) to the zip at `path`, calling `progress` with the number
/// of files done after each one. Written beside the destination and moved over it at the end,
/// so a failure leaves no half-written archive.
pub fn write_zip(
    path: &Path,
    items: &[BundleItem],
    format: Format,
    artist: &str,
    album: &str,
    progress: impl Fn(usize) + Sync,
) -> Result<()> {
    if items.is_empty() {
        bail!("nothing to export");
    }
    let names = archive_names(items, format);
    let partial = PathBuf::from(format!("{}.part", path.display()));
    let zip = Mutex::new(ZipWriter::new(BufWriter::new(
        File::create(&partial).with_context(|| format!("cannot write {}", partial.display()))?,
    )));
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let failure: Mutex<Option<anyhow::Error>> = Mutex::new(None);

    std::thread::scope(|scope| {
        for _ in 0..WORKERS.min(items.len()) {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= items.len() || failure.lock().unwrap().is_some() {
                        break;
                    }
                    let item = &items[i];
                    let tags = Tags { title: &item.title, artist, album, track: i + 1, total: items.len() };
                    let written = encode(Path::new(&item.source), format, &tags)
                        .and_then(|bytes| add_file(&mut zip.lock().unwrap(), &names[i], &bytes))
                        .with_context(|| format!("{}", Path::new(&item.source).display()));
                    match written {
                        Ok(()) => progress(done.fetch_add(1, Ordering::Relaxed) + 1),
                        Err(e) => {
                            failure.lock().unwrap().get_or_insert(e);
                        }
                    }
                }
            });
        }
    });

    let finished = match failure.into_inner().unwrap() {
        Some(e) => Err(e),
        None => zip
            .into_inner()
            .unwrap()
            .finish()
            .map_err(anyhow::Error::from)
            .and_then(|mut w| w.flush().map_err(Into::into))
            .and_then(|_| std::fs::rename(&partial, path).with_context(|| format!("cannot write {}", path.display()))),
    };
    if finished.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    finished
}

/// File names in the archive: each item's name (made safe) with the format's extension,
/// a repeated one numbered " (2)", " (3)", …
pub(crate) fn archive_names(items: &[BundleItem], format: Format) -> Vec<String> {
    let mut taken: Vec<String> = Vec::new();
    items
        .iter()
        .map(|item| {
            let stem = safe_name(&item.name);
            let stem = if stem.is_empty() { "Untitled".to_string() } else { stem };
            let mut name = format!("{stem}.{}", format.extension());
            let mut n = 2;
            while taken.iter().any(|t| t.eq_ignore_ascii_case(&name)) {
                name = format!("{stem} ({n}).{}", format.extension());
                n += 1;
            }
            taken.push(name.clone());
            name
        })
        .collect()
}

/// A file name without path separators, control characters or characters Windows refuses.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    cleaned.trim().trim_start_matches('.').trim().to_string()
}

fn add_file(zip: &mut ZipWriter<BufWriter<File>>, name: &str, bytes: &[u8]) -> Result<()> {
    // Audio barely compresses: stored as is.
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(bytes.len() as u64 >= u32::MAX as u64);
    zip.start_file(name, options)?;
    zip.write_all(bytes)?;
    Ok(())
}

fn encode(source: &Path, format: Format, tags: &Tags) -> Result<Vec<u8>> {
    let is_mp3 = source.extension().is_some_and(|e| e.eq_ignore_ascii_case("mp3"));
    if format == Format::Mp3 && is_mp3 {
        let bytes = std::fs::read(source)?;
        let mut out = id3v2(tags);
        out.extend_from_slice(strip_id3(&bytes));
        return Ok(out);
    }
    let audio = decode::decode_file(source)?;
    match format {
        Format::Wav => {
            let track = tags.track.to_string();
            let mut out = Vec::new();
            let info = [(*b"INAM", tags.title), (*b"IART", tags.artist), (*b"IPRD", tags.album), (*b"ITRK", track.as_str())];
            wav::write_wav_to(&mut out, &audio, false, &info)?;
            Ok(out)
        }
        Format::Flac => flac(&audio, tags),
        Format::Mp3 => mp3(&audio, tags),
    }
}

/// 24-bit FLAC with a Vorbis comment.
fn flac(audio: &AudioData, tags: &Tags) -> Result<Vec<u8>> {
    use flacenc::component::{BitRepr, MetadataBlockData};
    use flacenc::error::Verify;

    const BITS: usize = 24;
    let channels = audio.channels.len();
    let scale = ((1 << (BITS - 1)) - 1) as f32;
    let mut samples = Vec::with_capacity(audio.frames() * channels);
    for i in 0..audio.frames() {
        for ch in &audio.channels {
            samples.push((ch[i].clamp(-1.0, 1.0) * scale).round() as i32);
        }
    }
    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|(_, e)| anyhow!("FLAC encoder: {e:?}"))?;
    let source = flacenc::source::MemSource::from_samples(&samples, channels, BITS, audio.sample_rate as usize);
    let mut stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| anyhow!("FLAC encoder: {e:?}"))?;
    // flacenc puts the shorter last block in the minimum block size; a fixed-blocksize stream
    // states the same minimum and maximum (decoders such as Symphonia tell the two kinds apart
    // by it).
    let block = stream.stream_info().max_block_size();
    stream
        .stream_info_mut()
        .set_block_sizes(block, block)
        .map_err(|e| anyhow!("FLAC encoder: {e:?}"))?;
    let comment = vorbis_comment(tags);
    stream.add_metadata_block(MetadataBlockData::new_unknown(4, &comment).map_err(|e| anyhow!("FLAC tags: {e:?}"))?);
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream.write(&mut sink).map_err(|e| anyhow!("FLAC encoder: {e:?}"))?;
    Ok(sink.into_inner())
}

/// A FLAC VORBIS_COMMENT block's body.
fn vorbis_comment(tags: &Tags) -> Vec<u8> {
    let track = tags.track.to_string();
    let total = tags.total.to_string();
    let fields = [
        ("TITLE", tags.title),
        ("ARTIST", tags.artist),
        ("ALBUM", tags.album),
        ("TRACKNUMBER", track.as_str()),
        ("TRACKTOTAL", total.as_str()),
    ];
    let fields: Vec<String> = fields.iter().filter(|(_, v)| !v.is_empty()).map(|(k, v)| format!("{k}={v}")).collect();
    let vendor = b"(a/b)normal";
    let mut out = Vec::new();
    out.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    out.extend_from_slice(vendor);
    out.extend_from_slice(&(fields.len() as u32).to_le_bytes());
    for f in &fields {
        out.extend_from_slice(&(f.len() as u32).to_le_bytes());
        out.extend_from_slice(f.as_bytes());
    }
    out
}

/// 320 kb/s CBR MP3 (first two channels), with an ID3v2.4 tag.
fn mp3(audio: &AudioData, tags: &Tags) -> Result<Vec<u8>> {
    use mp3lame_encoder::{Bitrate, Builder, DualPcm, FlushNoGap, MonoPcm, Quality, VbrMode, max_required_buffer_size};

    let lame = |e: mp3lame_encoder::BuildError| anyhow!("MP3 encoder: {e}");
    let stereo = audio.channels.len() >= 2;
    let mut encoder = Builder::new()
        .ok_or_else(|| anyhow!("MP3 encoder unavailable"))?
        .with_num_channels(if stereo { 2 } else { 1 })
        .map_err(lame)?
        .with_sample_rate(audio.sample_rate)
        .map_err(lame)?
        .with_vbr_mode(VbrMode::Off)
        .map_err(lame)?
        .with_brate(Bitrate::Kbps320)
        .map_err(lame)?
        .with_quality(Quality::NearBest)
        .map_err(lame)?
        .build()
        .map_err(lame)?;

    const CHUNK: usize = 1152 * 64;
    let mut out = id3v2(tags);
    let encode = |e: mp3lame_encoder::EncodeError| anyhow!("MP3 encoder: {e}");
    let left = &audio.channels[0];
    for start in (0..left.len()).step_by(CHUNK) {
        let end = (start + CHUNK).min(left.len());
        out.reserve(max_required_buffer_size(end - start));
        if stereo {
            let input = DualPcm { left: &left[start..end], right: &audio.channels[1][start..end] };
            encoder.encode_to_vec(input, &mut out).map_err(encode)?;
        } else {
            encoder.encode_to_vec(MonoPcm(&left[start..end]), &mut out).map_err(encode)?;
        }
    }
    out.reserve(max_required_buffer_size(0));
    encoder.flush_to_vec::<FlushNoGap>(&mut out).map_err(encode)?;
    Ok(out)
}

/// An ID3v2.4 tag (UTF-8 text frames) with the non-empty tags.
fn id3v2(tags: &Tags) -> Vec<u8> {
    let track = format!("{}/{}", tags.track, tags.total);
    let mut frames = Vec::new();
    for (id, value) in [(b"TIT2", tags.title), (b"TPE1", tags.artist), (b"TALB", tags.album), (b"TRCK", track.as_str())] {
        if value.is_empty() {
            continue;
        }
        frames.extend_from_slice(id);
        frames.extend_from_slice(&syncsafe(value.len() as u32 + 1));
        frames.extend_from_slice(&[0, 0, 3]); // no flags; UTF-8
        frames.extend_from_slice(value.as_bytes());
    }
    let mut tag = b"ID3\x04\x00\x00".to_vec();
    tag.extend_from_slice(&syncsafe(frames.len() as u32));
    tag.extend_from_slice(&frames);
    tag
}

fn syncsafe(n: u32) -> [u8; 4] {
    [(n >> 21) as u8 & 0x7f, (n >> 14) as u8 & 0x7f, (n >> 7) as u8 & 0x7f, n as u8 & 0x7f]
}

/// An MP3's frames without its ID3v2 tags (leading, possibly several) or ID3v1 tag (trailing).
fn strip_id3(mut bytes: &[u8]) -> &[u8] {
    while bytes.len() >= 10 && &bytes[..3] == b"ID3" {
        let size = bytes[6..10].iter().fold(0usize, |n, &b| (n << 7) | (b & 0x7f) as usize);
        let footer = if bytes[5] & 0x10 != 0 { 10 } else { 0 };
        bytes = &bytes[(10 + size + footer).min(bytes.len())..];
    }
    if bytes.len() >= 128 && &bytes[bytes.len() - 128..][..3] == b"TAG" {
        bytes = &bytes[..bytes.len() - 128];
    }
    bytes
}
