//! WAV files: little-endian RIFF/WAVE, 24-bit PCM (clipped to full scale) or 32-bit IEEE float,
//! with an optional LIST/INFO chunk of tags. Written for Export as Zip (`bundle.rs`).

use std::io::Write;

use anyhow::{Result, anyhow};

use crate::decode::AudioData;

/// `audio` as WAV to any writer: 24-bit PCM, or 32-bit float when `float`; with a LIST/INFO chunk of `info` tags (`INAM`, `IART`, …,
/// UTF-8) before the samples when there are any.
pub fn write_wav_to(w: &mut impl Write, audio: &AudioData, float: bool, info: &[([u8; 4], &str)]) -> Result<()> {
    let channels = audio.channels.len() as u16;
    let bytes_per_sample: u16 = if float { 4 } else { 3 };
    let block_align = channels * bytes_per_sample;
    let data_len = audio.frames() as u64 * block_align as u64;
    let data_len = u32::try_from(data_len).map_err(|_| anyhow!("too long for a WAV file"))?;
    let list = info_chunk(info);
    // Chunks are word-aligned: an odd data chunk is followed by a pad byte.
    let pad = (data_len % 2) as u32;
    let riff_len = (36 + data_len as u64 + pad as u64 + list.len() as u64)
        .try_into()
        .map_err(|_| anyhow!("too long for a WAV file"))?;

    w.write_all(b"RIFF")?;
    w.write_all(&u32::to_le_bytes(riff_len))?;
    w.write_all(b"WAVEfmt ")?;
    w.write_all(&16u32.to_le_bytes())?;
    w.write_all(&(if float { 3u16 } else { 1u16 }).to_le_bytes())?;
    w.write_all(&channels.to_le_bytes())?;
    w.write_all(&audio.sample_rate.to_le_bytes())?;
    w.write_all(&(audio.sample_rate * block_align as u32).to_le_bytes())?;
    w.write_all(&block_align.to_le_bytes())?;
    w.write_all(&(bytes_per_sample * 8).to_le_bytes())?;
    w.write_all(&list)?;
    w.write_all(b"data")?;
    w.write_all(&data_len.to_le_bytes())?;
    for i in 0..audio.frames() {
        for ch in &audio.channels {
            let s = ch[i];
            if float {
                w.write_all(&s.to_le_bytes())?;
            } else {
                let v = (s.clamp(-1.0, 1.0) as f64 * 8_388_607.0).round() as i32;
                w.write_all(&v.to_le_bytes()[..3])?;
            }
        }
    }
    if pad == 1 {
        w.write_all(&[0])?;
    }
    Ok(())
}

/// `LIST` chunk of type `INFO` holding the non-empty tags (each NUL-terminated, word-aligned),
/// or nothing when there are none.
fn info_chunk(info: &[([u8; 4], &str)]) -> Vec<u8> {
    let mut body = b"INFO".to_vec();
    for (id, value) in info.iter().filter(|(_, v)| !v.is_empty()) {
        let len = value.len() + 1;
        body.extend_from_slice(id);
        body.extend_from_slice(&(len as u32).to_le_bytes());
        body.extend_from_slice(value.as_bytes());
        body.push(0);
        if len % 2 == 1 {
            body.push(0);
        }
    }
    if body.len() == 4 {
        return Vec::new();
    }
    let mut chunk = b"LIST".to_vec();
    chunk.extend_from_slice(&(body.len() as u32).to_le_bytes());
    chunk.extend_from_slice(&body);
    chunk
}
