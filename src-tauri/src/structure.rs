//! Song structure (tempo, beats, bars, labelled sections: intro, verse, chorus, …) from
//! All-In-One (github.com/mir-aidj/all-in-one), a PyTorch model run in a private Python
//! environment that this module sets up with `uv` on request.
//!
//! The environment lives in `<app data>/allin1/` with the model weights. NATTEN, which allin1
//! imports, is not installed: `natten_shim.py` replaces it with plain PyTorch, so nothing has
//! to compile against the GPU toolchain, and it is much faster on CPU than NATTEN's own CPU
//! kernels.
//!
//! A job has two stages, each with its own worker: stem separation (Demucs, on the GPU, ~12 s
//! for a 3-minute song) and the structure model (8-model ensemble on CPU, ~15 s). So while one
//! track's model runs, the next track's stems are being separated.
//!
//! Results are cached per file (path, size, mtime), so each file is only ever analysed once.
//! The user's corrections (moved boundaries, renamed parts) are kept separately and win over
//! the detected structure; they are keyed without `VERSION`, so a model update keeps them.

use std::collections::{HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

const RUNNER: &str = include_str!("structure_runner.py");
const SHIM: &str = include_str!("natten_shim.py");
/// Bump when the runner or model change what is detected, so cached results are recomputed.
const VERSION: &str = "1";
/// Bump when the install steps change, so the environment is set up again.
const ENV_VERSION: &str = "1";
const PYTHON: &str = "3.11";
const MADMOM: &str = "madmom @ git+https://github.com/CPJKU/madmom@27f032e8947204902c675e5e341a3faf5dc86dae";
/// `uv`, which Finder-launched apps won't find on PATH; searched in this order after PATH.
const UV_CANDIDATES: [&str; 4] = [".local/bin/uv", ".cargo/bin/uv", "/opt/homebrew/bin/uv", "/usr/local/bin/uv"];
/// Prepended to PATH for every subprocess: Homebrew holds ffmpeg (Demucs reads audio with it)
/// and git (madmom is installed from git).
const TOOL_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

/// Install steps: label shown in the UI, then `uv` arguments (`{py}` = the env's python).
const STEPS: [(&str, &[&str]); 5] = [
    ("Creating Python environment", &["venv", "--python", PYTHON, "{env}"]),
    (
        "Installing PyTorch",
        &["pip", "install", "--python", "{py}", "torch==2.4.1", "torchaudio==2.4.1", "numpy==1.26.4", "cython==3.3.0", "setuptools==84.0.0", "wheel"],
    ),
    ("Building madmom", &["pip", "install", "--python", "{py}", "--no-build-isolation", MADMOM]),
    (
        "Installing Demucs and allin1",
        &[
            "pip", "install", "--python", "{py}", "demucs==4.0.1", "huggingface-hub==2.2.0", "hydra-core==1.3.7", "librosa==0.11.0",
            "matplotlib==3.11.2", "omegaconf==2.3.1",
        ],
    ),
    // allin1 declares NATTEN as a dependency on macOS, which we replace, so no deps here.
    ("Installing allin1", &["pip", "install", "--python", "{py}", "--no-deps", "allin1==1.1.0"]),
];

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    /// "start", "end" (silence), "intro", "verse", "chorus", "bridge", "inst", "solo", "break", "outro".
    pub label: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Structure {
    pub bpm: Option<f64>,
    pub beats: Vec<f64>,
    /// First beat of each bar.
    pub downbeats: Vec<f64>,
    /// Position of each beat in its bar, 1-based.
    pub beat_positions: Vec<u32>,
    pub segments: Vec<Segment>,
    /// The segments are the user's corrections rather than what was detected.
    #[serde(default)]
    pub edited: bool,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub installed: bool,
    pub installing: bool,
    /// Current install step, e.g. "Installing PyTorch (2/5)".
    pub step: Option<String>,
    pub error: Option<String>,
}

/// One finished (or failed) analysis, sent as the `structure` event.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub path: String,
    pub structure: Option<Structure>,
    pub error: Option<String>,
}

pub type Notify = Arc<dyn Fn(&Outcome) + Send + Sync>;

pub struct Engine {
    home: PathBuf,
    root: PathBuf,
    setup: Mutex<SetupStatus>,
    queue: Mutex<Jobs>,
}

#[derive(Default)]
struct Jobs {
    /// Waiting for stem separation, then for the model.
    demix: VecDeque<PathBuf>,
    model: VecDeque<PathBuf>,
    /// Queued or running, in either stage.
    in_flight: HashSet<PathBuf>,
    demix_busy: bool,
    model_busy: bool,
    notify: Option<Notify>,
}

#[derive(Clone, Copy)]
enum Stage {
    Demix,
    Model,
}

impl Engine {
    pub fn new(home: PathBuf, root: PathBuf) -> Self {
        let engine = Engine { home, root, setup: Mutex::new(SetupStatus::default()), queue: Mutex::new(Jobs::default()) };
        engine.setup.lock().unwrap().installed = engine.ready_marker().is_file();
        engine
    }

    pub fn status(&self) -> SetupStatus {
        self.setup.lock().unwrap().clone()
    }

    fn env(&self) -> PathBuf {
        self.root.join("env")
    }

    fn python(&self) -> PathBuf {
        self.env().join("bin/python")
    }

    fn ready_marker(&self) -> PathBuf {
        self.env().join(format!(".abnormal-ready-{ENV_VERSION}"))
    }

    /// Set up the environment (several minutes, ~1 GB), calling `progress` after each change.
    /// Returns at once if it is already installed or installing.
    pub fn install(&self, progress: &dyn Fn(&SetupStatus)) {
        {
            let mut s = self.setup.lock().unwrap();
            if s.installed || s.installing {
                return;
            }
            *s = SetupStatus { installing: true, ..Default::default() };
        }
        let result = self.run_install(progress);
        let status = {
            let mut s = self.setup.lock().unwrap();
            *s = SetupStatus { installed: result.is_ok(), installing: false, step: None, error: result.err() };
            s.clone()
        };
        progress(&status);
    }

    fn run_install(&self, progress: &dyn Fn(&SetupStatus)) -> Result<(), String> {
        let uv = self.find_uv().ok_or("uv not found: install it with `brew install uv`, then try again")?;
        // A half-finished environment from an earlier attempt would confuse `uv venv`.
        let _ = std::fs::remove_dir_all(self.env());
        std::fs::create_dir_all(&self.root).map_err(|e| format!("cannot create {}: {e}", self.root.display()))?;
        let log_path = self.root.join("install.log");
        for (i, (label, args)) in STEPS.iter().enumerate() {
            let step = format!("{label} ({}/{})", i + 1, STEPS.len());
            let status = {
                let mut s = self.setup.lock().unwrap();
                s.step = Some(step.clone());
                s.clone()
            };
            progress(&status);
            let args: Vec<String> = args
                .iter()
                .map(|a| a.replace("{env}", &self.env().to_string_lossy()).replace("{py}", &self.python().to_string_lossy()))
                .collect();
            let log = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e| e.to_string())?;
            let out = Command::new(&uv)
                .args(&args)
                .env("PATH", TOOL_PATH)
                .stdin(Stdio::null())
                .stdout(log.try_clone().map_err(|e| e.to_string())?)
                .stderr(log)
                .status()
                .map_err(|e| format!("{label}: cannot run uv: {e}"))?;
            if !out.success() {
                return Err(format!("{label} failed: see {}", log_path.display()));
            }
        }
        std::fs::write(self.ready_marker(), "").map_err(|e| e.to_string())
    }

    fn find_uv(&self) -> Option<PathBuf> {
        let on_path = std::env::var_os("PATH").into_iter().flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).map(|d| d.join("uv"));
        let known = UV_CANDIDATES.iter().map(|c| if c.starts_with('/') { PathBuf::from(c) } else { self.home.join(c) });
        on_path.chain(known).find(|p| p.is_file())
    }

    /// The structure of `path`: the user's corrections if any, else the detected one, if it has
    /// been analysed (and the file hasn't changed since).
    pub fn cached(&self, path: &Path) -> Option<Structure> {
        let detected = self.detected(path)?;
        let edits = self.edit_file(path).and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice::<Vec<Segment>>(&b).ok());
        Some(match edits {
            Some(segments) => Structure { segments, edited: true, ..detected },
            None => detected,
        })
    }

    fn detected(&self, path: &Path) -> Option<Structure> {
        let bytes = std::fs::read(self.cache_file(path)?).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Keep the user's corrected parts for `path`, returning the structure with them.
    pub fn save_edit(&self, path: &Path, segments: Vec<Segment>) -> Result<Structure, String> {
        let detected = self.detected(path).ok_or("the track has no detected structure to edit")?;
        let file = self.edit_file(path).ok_or_else(|| format!("cannot read {}", path.display()))?;
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&file, serde_json::to_vec(&segments).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(Structure { segments, edited: true, ..detected })
    }

    /// Drop the user's corrections for `path`, returning the detected structure.
    pub fn reset_edit(&self, path: &Path) -> Option<Structure> {
        if let Some(file) = self.edit_file(path) {
            let _ = std::fs::remove_file(file);
        }
        self.detected(path)
    }

    /// Queue `path` for analysis unless it is cached or already queued; `notify` is called when
    /// it is done. Does nothing if the environment isn't installed.
    pub fn request(self: &Arc<Self>, path: PathBuf, notify: Notify) {
        if !self.status().installed || self.cached(&path).is_some() {
            return;
        }
        let mut jobs = self.queue.lock().unwrap();
        jobs.notify = Some(notify);
        if !jobs.in_flight.insert(path.clone()) {
            return;
        }
        jobs.demix.push_back(path);
        self.wake(&mut jobs, Stage::Demix);
    }

    /// Start the stage's worker if it is idle.
    fn wake(self: &Arc<Self>, jobs: &mut Jobs, stage: Stage) {
        let busy = match stage {
            Stage::Demix => &mut jobs.demix_busy,
            Stage::Model => &mut jobs.model_busy,
        };
        if !*busy {
            *busy = true;
            let engine = self.clone();
            std::thread::spawn(move || engine.work(stage));
        }
    }

    fn work(self: &Arc<Self>, stage: Stage) {
        loop {
            let path = {
                let mut jobs = self.queue.lock().unwrap();
                let next = match stage {
                    Stage::Demix => jobs.demix.pop_front(),
                    Stage::Model => jobs.model.pop_front(),
                };
                match next {
                    Some(p) => p,
                    None => {
                        match stage {
                            Stage::Demix => jobs.demix_busy = false,
                            Stage::Model => jobs.model_busy = false,
                        }
                        return;
                    }
                }
            };
            let result = match stage {
                Stage::Demix => self.demix(&path).map(|()| None),
                Stage::Model => self.model(&path).map(Some),
            };
            let mut jobs = self.queue.lock().unwrap();
            match result {
                // Stems ready: on to the model.
                Ok(None) => {
                    jobs.model.push_back(path);
                    self.wake(&mut jobs, Stage::Model);
                }
                Ok(Some(structure)) => self.finish(&mut jobs, path, Ok(structure)),
                Err(e) => self.finish(&mut jobs, path, Err(e)),
            }
        }
    }

    fn finish(&self, jobs: &mut Jobs, path: PathBuf, result: Result<Structure, String>) {
        jobs.in_flight.remove(&path);
        let outcome = match result {
            Ok(structure) => Outcome { path: path.to_string_lossy().into_owned(), structure: Some(structure), error: None },
            Err(e) => {
                let _ = std::fs::remove_dir_all(self.work_dir(&path));
                Outcome { path: path.to_string_lossy().into_owned(), structure: None, error: Some(e) }
            }
        };
        if let Some(notify) = &jobs.notify {
            notify(&outcome);
        }
    }

    fn work_dir(&self, path: &Path) -> PathBuf {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        path.hash(&mut h);
        self.root.join("work").join(format!("{:016x}", h.finish()))
    }

    fn demix(&self, path: &Path) -> Result<(), String> {
        let work = self.work_dir(path);
        let _ = std::fs::remove_dir_all(&work);
        self.run(path, &[&"demix".into(), &path.as_os_str().into(), &work.as_os_str().into()])
    }

    fn model(&self, path: &Path) -> Result<Structure, String> {
        let cache = self.cache_file(path).ok_or_else(|| format!("cannot read {}", path.display()))?;
        let out = self.work_dir(path).with_extension("json");
        let work = self.work_dir(path);
        self.run(path, &[&"structure".into(), &path.as_os_str().into(), &out.as_os_str().into(), &work.as_os_str().into()])?;
        let bytes = std::fs::read(&out).map_err(|e| format!("no structure result: {e}"))?;
        let _ = std::fs::remove_file(&out);
        let structure: Structure = serde_json::from_slice(&bytes).map_err(|e| format!("bad structure result: {e}"))?;
        if let Some(dir) = cache.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&cache, &bytes).map_err(|e| e.to_string())?;
        Ok(structure)
    }

    /// Run one stage of the runner script, with the scripts (re)written next to it.
    fn run(&self, path: &Path, args: &[&std::ffi::OsString]) -> Result<(), String> {
        let scripts = self.root.join("scripts");
        std::fs::create_dir_all(&scripts).map_err(|e| e.to_string())?;
        let runner = scripts.join("structure_runner.py");
        std::fs::write(&runner, RUNNER).map_err(|e| e.to_string())?;
        std::fs::write(scripts.join("natten_shim.py"), SHIM).map_err(|e| e.to_string())?;

        let models = self.root.join("models");
        let mut child = Command::new(self.python())
            .arg(&runner)
            .args(args)
            .env("PATH", format!("{}:{TOOL_PATH}", self.env().join("bin").display()))
            .env("TORCH_HOME", models.join("torch"))
            .env("HF_HOME", models.join("huggingface"))
            .env("MPLCONFIGDIR", self.root.join("matplotlib"))
            .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot start the structure model: {e}"))?;
        // Drain stderr on its own thread so a chatty run can't fill the pipe and stall.
        let stderr = child.stderr.take().unwrap();
        let errors = std::thread::spawn(move || {
            let mut tail: VecDeque<String> = VecDeque::new();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                tail.push_back(line);
                if tail.len() > 20 {
                    tail.pop_front();
                }
            }
            tail
        });
        for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
            if line.starts_with("{\"stage\"") {
                eprintln!("structure {}: {line}", path.display());
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        let tail = errors.join().unwrap_or_default();
        if status.success() {
            return Ok(());
        }
        let last = tail.iter().rev().find(|l| !l.trim().is_empty()).cloned().unwrap_or_default();
        Err(format!("structure analysis failed: {}", last.trim()))
    }

    /// Cache file for the current version of `path` (keyed on path, size and mtime).
    fn cache_file(&self, path: &Path) -> Option<PathBuf> {
        Some(self.root.join("cache").join(format!("{:016x}.json", file_key(path, VERSION)?)))
    }

    /// The user's corrections for this version of the file; independent of `VERSION`.
    fn edit_file(&self, path: &Path) -> Option<PathBuf> {
        Some(self.root.join("edits").join(format!("{:016x}.json", file_key(path, "")?)))
    }
}

fn file_key(path: &Path, version: &str) -> Option<u64> {
    use std::hash::{Hash, Hasher};
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (version, path, meta.len(), modified).hash(&mut h);
    Some(h.finish())
}
