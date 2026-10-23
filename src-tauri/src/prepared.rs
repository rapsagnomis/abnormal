//! Versions prepared ahead, so switching a lane to another version is seamless: every version of
//! a song with several (the UI says which files, `want`) is decoded, resampled for playback and
//! fully analysed in the background, and kept here. Loading a prepared file only swaps buffers,
//! and its analysis comes back at once.
//!
//! Entries are checked against the file's size and modification time, so a version re-bounced
//! over the same file is prepared again. Past a memory budget only the analysis is kept (decoding
//! is quick next to it); files no longer wanted are dropped.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use crate::decode::AudioData;
use crate::player::{PlaybackBuffer, SLOTS};

/// Decoded audio and playback copies kept at most this big, bytes.
const BUDGET_BYTES: usize = 4 << 30;

/// A file as it is on disk: size and modification time.
pub type Stamp = (u64, Option<SystemTime>);

pub fn stamp_of(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()))
}

/// A file ready to play: its audio, playback copy (none without an output device) and the
/// details sent to the UI (`I`).
pub struct Decoded<I> {
    pub audio: Arc<AudioData>,
    pub buffer: Option<Arc<PlaybackBuffer>>,
    pub info: I,
}

impl<I: Clone> Clone for Decoded<I> {
    fn clone(&self) -> Self {
        Self { audio: self.audio.clone(), buffer: self.buffer.clone(), info: self.info.clone() }
    }
}

impl<I> Decoded<I> {
    fn bytes(&self) -> usize {
        let audio = self.audio.frames() * self.audio.channels.len() * 4;
        audio + self.buffer.as_ref().map_or(0, |b| b.frames() as usize * 2 * 4)
    }
}

struct Entry<I> {
    stamp: Stamp,
    /// None past the budget (or not decoded yet).
    decoded: Option<Decoded<I>>,
    /// The whole-track analysis (with curves) as the JSON the UI receives.
    report: Option<Arc<str>>,
    /// Couldn't be decoded or analysed as it is: not tried again until the file changes.
    failed: bool,
}

pub struct Prepared<I> {
    entries: Mutex<HashMap<String, Entry<I>>>,
    /// The files to keep prepared, in the order to prepare them.
    wanted: Mutex<Vec<String>>,
    /// Which file (as it was when loaded) each slot plays, to find its analysis.
    slots: Mutex<[Option<(String, Stamp)>; SLOTS]>,
    /// The background worker is running.
    pub working: AtomicBool,
}

impl<I: Clone> Prepared<I> {
    pub fn new() -> Self {
        Self { entries: Mutex::default(), wanted: Mutex::default(), slots: Mutex::new(Default::default()), working: AtomicBool::new(false) }
    }

    /// Keep these files prepared (and only these).
    pub fn want(&self, paths: Vec<String>) {
        self.entries.lock().unwrap().retain(|path, _| paths.contains(path));
        *self.wanted.lock().unwrap() = paths;
    }

    fn is_wanted(&self, path: &str) -> bool {
        self.wanted.lock().unwrap().iter().any(|p| p == path)
    }

    /// The file, ready to play, if it's prepared as it is now on disk.
    pub fn decoded(&self, path: &str) -> Option<Decoded<I>> {
        let stamp = stamp_of(Path::new(path))?;
        let entries = self.entries.lock().unwrap();
        entries.get(path).filter(|e| e.stamp == stamp).and_then(|e| e.decoded.clone())
    }

    /// `slot` now plays `path` (as it was at `stamp`), or nothing.
    pub fn set_slot(&self, slot: usize, playing: Option<(String, Stamp)>) {
        self.slots.lock().unwrap()[slot] = playing;
    }

    /// The whole-track analysis of what `slot` plays, if it's been made for the file as it is.
    pub fn slot_report(&self, slot: usize) -> Option<Arc<str>> {
        let (path, stamp) = self.slots.lock().unwrap()[slot].clone()?;
        let entries = self.entries.lock().unwrap();
        entries.get(&path).filter(|e| e.stamp == stamp).and_then(|e| e.report.clone())
    }

    /// Keep what's known about a wanted file: its decoded audio (within the budget) and/or its
    /// analysis. What's already kept for the same file as it is stays.
    pub fn keep(&self, path: &str, stamp: Stamp, decoded: Option<&Decoded<I>>, report: Option<Arc<str>>) {
        if !self.is_wanted(path) {
            return;
        }
        let mut entries = self.entries.lock().unwrap();
        let used: usize = entries.iter().filter(|(p, _)| p.as_str() != path).filter_map(|(_, e)| e.decoded.as_ref()).map(Decoded::bytes).sum();
        let entry = entries.entry(path.to_owned()).or_insert(Entry { stamp, decoded: None, report: None, failed: false });
        if entry.stamp != stamp {
            *entry = Entry { stamp, decoded: None, report: None, failed: false };
        }
        if let Some(d) = decoded.filter(|d| entry.decoded.is_none() && used + d.bytes() <= BUDGET_BYTES) {
            entry.decoded = Some(d.clone());
        }
        if report.is_some() {
            entry.report = report;
        }
    }

    /// The slot's file's analysis, made after loading it: kept if the file is wanted.
    pub fn keep_slot_report(&self, slot: usize, report: Arc<str>) {
        let Some((path, stamp)) = self.slots.lock().unwrap()[slot].clone() else { return };
        self.keep(&path, stamp, None, Some(report));
    }

    pub fn fail(&self, path: &str, stamp: Stamp) {
        if self.is_wanted(path) {
            self.entries.lock().unwrap().insert(path.to_owned(), Entry { stamp, decoded: None, report: None, failed: true });
        }
    }

    /// The next wanted file still to prepare (not kept as it is now, or without its analysis).
    pub fn next(&self) -> Option<(String, Stamp)> {
        let wanted = self.wanted.lock().unwrap().clone();
        let entries = self.entries.lock().unwrap();
        wanted.into_iter().find_map(|path| {
            let stamp = stamp_of(Path::new(&path))?;
            let done = entries.get(&path).is_some_and(|e| e.stamp == stamp && (e.failed || e.report.is_some()));
            (!done).then_some((path, stamp))
        })
    }

    /// Wanted files whose analysis is ready for the file as it is now.
    pub fn ready(&self) -> Vec<String> {
        let entries = self.entries.lock().unwrap();
        let wanted = self.wanted.lock().unwrap().clone();
        wanted
            .into_iter()
            .filter(|p| entries.get(p).is_some_and(|e| e.report.is_some() && stamp_of(Path::new(p)) == Some(e.stamp)))
            .collect()
    }
}
