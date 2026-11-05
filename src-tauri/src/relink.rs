//! Finding a session's files again after they were renamed or moved outside the app.
//!
//! Each file is saved with two clues besides its paths: a macOS bookmark (the system follows a
//! file renamed or moved within its volume, like Logic or Final Cut do) and an identity (size and
//! a hash of its first and last 64 KiB, cheap to read), used to search the folders around it
//! when the bookmark can't help (another platform, a copy to another disk, older bookmarks).

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Bytes hashed at each end of a file.
const EDGE_BYTES: u64 = 64 << 10;
/// Folders searched below each starting folder.
const SEARCH_DEPTH: usize = 2;
/// Directory entries looked at in all, so a search near a big folder stays quick.
const SEARCH_LIMIT: usize = 20_000;

/// What a file is, to recognise it under another name.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Identity {
    pub size: u64,
    /// SHA-256 (first 128 bits, hex) of the size, the first and the last `EDGE_BYTES`.
    pub hash: String,
}

pub fn identity(path: &Path) -> Option<Identity> {
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let mut hash = Sha256::new();
    hash.update(size.to_le_bytes());
    let mut buf = vec![0; EDGE_BYTES.min(size) as usize];
    file.read_exact(&mut buf).ok()?;
    hash.update(&buf);
    if size > EDGE_BYTES {
        let tail = EDGE_BYTES.min(size - EDGE_BYTES);
        file.seek(SeekFrom::End(-(tail as i64))).ok()?;
        buf.resize(tail as usize, 0);
        file.read_exact(&mut buf).ok()?;
        hash.update(&buf);
    }
    let hash = hash.finalize()[..16].iter().map(|b| format!("{b:02x}")).collect();
    Some(Identity { size, hash })
}

/// Look for the file with this identity in `near` (and their subfolders, `SEARCH_DEPTH` deep):
/// candidates of the same size are hashed. The first match found, folders in the order given.
pub fn search(id: &Identity, near: &[PathBuf]) -> Option<PathBuf> {
    let mut seen = 0;
    let mut visited: Vec<PathBuf> = Vec::new();
    for dir in near {
        if let Some(found) = search_in(dir, id, SEARCH_DEPTH, &mut seen, &mut visited) {
            return Some(found);
        }
    }
    None
}

fn search_in(dir: &Path, id: &Identity, depth: usize, seen: &mut usize, visited: &mut Vec<PathBuf>) -> Option<PathBuf> {
    if visited.iter().any(|v| v == dir) {
        return None;
    }
    visited.push(dir.to_owned());
    let mut subdirs = Vec::new();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        *seen += 1;
        if *seen > SEARCH_LIMIT {
            return None;
        }
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            if !entry.file_name().to_string_lossy().starts_with('.') {
                subdirs.push(path);
            }
        } else if kind.is_file()
            && !in_trash(&path)
            && entry.metadata().is_ok_and(|m| m.len() == id.size)
            && identity(&path).as_ref() == Some(id)
        {
            return Some(path);
        }
    }
    if depth == 0 {
        return None;
    }
    subdirs.into_iter().find_map(|sub| search_in(&sub, id, depth - 1, seen, visited))
}

/// A file in the Trash (or Windows' Recycle Bin) isn't one to relink to.
fn in_trash(path: &Path) -> bool {
    path.components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        name == ".Trash" || name == ".Trashes" || name.eq_ignore_ascii_case("$Recycle.Bin")
    })
}

/// A bookmark to the file at `path` (base64), or None where bookmarks aren't available.
#[cfg(target_os = "macos")]
pub fn bookmark(path: &Path) -> Option<String> {
    use base64::Engine;
    use objc2_foundation::{NSString, NSURL, NSURLBookmarkCreationOptions};
    let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
    let data = url
        .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(NSURLBookmarkCreationOptions::empty(), None, None)
        .ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(data.to_vec()))
}

/// Where the bookmark's file is now, if it still exists (and isn't in the Trash).
#[cfg(target_os = "macos")]
pub fn resolve(bookmark: &str) -> Option<PathBuf> {
    use base64::Engine;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSData, NSURL, NSURLBookmarkResolutionOptions};
    let bytes = base64::engine::general_purpose::STANDARD.decode(bookmark).ok()?;
    let data = NSData::with_bytes(&bytes);
    let mut stale = Bool::NO;
    let options = NSURLBookmarkResolutionOptions::WithoutUI | NSURLBookmarkResolutionOptions::WithoutMounting;
    // SAFETY: `stale` is a valid pointer for the call.
    let url = unsafe { NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(&data, options, None, &mut stale) }.ok()?;
    let path = PathBuf::from(url.path()?.to_string());
    (path.is_file() && !in_trash(&path)).then_some(path)
}

#[cfg(not(target_os = "macos"))]
pub fn bookmark(_path: &Path) -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn resolve(_bookmark: &str) -> Option<PathBuf> {
    None
}
