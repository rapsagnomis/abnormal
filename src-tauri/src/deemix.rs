//! Deezer search and lossless downloads through Deemix, without opening its window.
//!
//! The Deemix desktop app bundles an HTTP server (the one its window talks to). We run that
//! server headless with the app's own Electron binary in Node mode, on a free local port, with
//! its own data folder inside ours: the Deemix GUI's queue and login are never touched, and it
//! doesn't matter whether the GUI is running. The user's Deemix settings (naming, bitrate
//! fallback, …) are copied in on every start, with the download folder forced to the library.
//!
//! The server runs in single-user mode: the ARL pasted once is saved by Deemix in our data
//! folder, and handed back by `/api/connect` for auto-login on later starts. We never write it.
//!
//! Deemix is looked for where its installers put it on macOS and Windows (see `Install`). Builds
//! without the `deezer` Cargo feature leave all of this out: Deezer is then reported unavailable.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

/// The server script inside the app's resources folder.
const SERVER_JS: &str = "app.asar/server/dist/app.js";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
/// Deemix's code for FLAC.
const FLAC: u32 = 9;

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// This build includes Deezer downloads (the `deezer` feature).
    pub available: bool,
    pub installed: bool,
    /// Where Deemix is looked for, to say so when it isn't there.
    pub location: Option<String>,
    pub logged_in: bool,
    /// Deezer account name once logged in.
    pub user: Option<String>,
    /// The account can stream FLAC; without it downloads fail (or fall back, per settings).
    pub lossless: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeezerTrack {
    pub id: u64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_id: u64,
    pub duration: f64,
    /// 56 px album cover.
    pub cover: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub uuid: String,
    /// "track" or "album".
    pub kind: String,
    pub id: u64,
    pub title: String,
    pub artist: String,
    /// Tracks in the item, and how many are downloaded or failed.
    pub size: u64,
    pub downloaded: u64,
    pub failed: u64,
    /// 0–100.
    pub progress: f64,
    /// "inQueue", "downloading", "completed", "withErrors" or "failed".
    pub status: String,
    /// Files written, once the item is finished.
    pub files: Vec<DownloadedFile>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedFile {
    /// Deezer id of the track in this file (an album item has one per track).
    pub track_id: u64,
    pub path: String,
}

impl QueueItem {
    pub fn finished(&self) -> bool {
        !matches!(self.status.as_str(), "inQueue" | "downloading")
    }
}

struct Server {
    child: Child,
    base: String,
    /// Keeps the session cookie: Deemix logs in per session.
    agent: ureq::Agent,
    status: Status,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Where the Deemix desktop app is: its Electron binary, its resources folder (holding the
/// server) and the GUI's own settings, as its installers lay them out.
struct Install {
    binary: PathBuf,
    resources: PathBuf,
    gui_config: PathBuf,
}

impl Install {
    #[cfg(target_os = "macos")]
    fn locate(home: &Path) -> Option<Install> {
        let gui_config = home.join("Library/Application Support/deemix/config.json");
        let at = |apps: PathBuf| {
            let app = apps.join("deemix-gui.app");
            Install { binary: app.join("Contents/MacOS/deemix-gui"), resources: app.join("Contents/Resources"), gui_config: gui_config.clone() }
        };
        // The system Applications folder, else the user's own; reported at the first when in neither.
        let system = at(PathBuf::from("/Applications"));
        let user = at(home.join("Applications"));
        Some(if !system.binary.is_file() && user.binary.is_file() { user } else { system })
    }

    /// The NSIS installer puts it in the user's programs folder (unverified on a real machine).
    #[cfg(windows)]
    fn locate(home: &Path) -> Option<Install> {
        let local = std::env::var_os("LOCALAPPDATA").map_or_else(|| home.join("AppData/Local"), PathBuf::from);
        let roaming = std::env::var_os("APPDATA").map_or_else(|| home.join("AppData/Roaming"), PathBuf::from);
        let app = local.join("Programs").join("deemix-gui");
        Some(Install { binary: app.join("deemix-gui.exe"), resources: app.join("resources"), gui_config: roaming.join("deemix").join("config.json") })
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    fn locate(_home: &Path) -> Option<Install> {
        None
    }

    fn server_js(&self) -> PathBuf {
        self.resources.join(SERVER_JS)
    }

    fn installed(&self) -> bool {
        cfg!(feature = "deezer") && self.binary.is_file()
    }
}

pub struct Deemix {
    install: Option<Install>,
    data_dir: PathBuf,
    /// Where downloads go: the library folder (None until one is chosen).
    music_dir: Mutex<Option<PathBuf>>,
    server: Mutex<Option<Server>>,
}

impl Deemix {
    pub fn new(home: &Path, data_dir: PathBuf, music_dir: Option<PathBuf>) -> Self {
        Deemix { install: Install::locate(home), data_dir, music_dir: Mutex::new(music_dir), server: Mutex::new(None) }
    }

    fn installed(&self) -> bool {
        self.install.as_ref().is_some_and(Install::installed)
    }

    /// Download into another folder from now on. A running server is stopped (it was started
    /// with the old one) and starts again on next use.
    pub fn set_music_dir(&self, dir: PathBuf) {
        *self.music_dir.lock().unwrap() = Some(dir);
        *self.server.lock().unwrap() = None;
    }

    /// What's known before starting anything: whether Deezer can be used at all.
    fn base_status(&self) -> Status {
        Status {
            available: cfg!(feature = "deezer"),
            installed: self.installed(),
            location: self.install.as_ref().map(|i| i.binary.display().to_string()),
            ..Status::default()
        }
    }

    /// Start the server if needed and log in with the saved ARL if there is one.
    pub fn connect(&self) -> Result<Status, String> {
        if !self.installed() {
            return Ok(self.base_status());
        }
        let mut guard = self.server.lock().unwrap();
        let server = self.running(&mut guard)?;
        if !server.status.logged_in {
            let connect = get(server, "connect", &[])?;
            let saved = connect["singleUser"]["arl"].as_str().filter(|a| !a.is_empty());
            // Deemix forgets the saved ARL after any failed login, including when Deezer is
            // unreachable, so only try it when Deezer is up.
            let reachable = connect["deezerAvailable"].as_bool().unwrap_or(true);
            if let Some(arl) = saved.filter(|_| reachable) {
                // A rejected saved ARL just leaves us logged out; the user can paste a new one.
                let _ = login(server, arl);
            } else if !connect["autologin"].as_bool().unwrap_or(true) {
                server.status = logged_in_status(&connect["currentUser"], &server.status);
            }
        }
        Ok(server.status.clone())
    }

    /// Log in with a pasted ARL; Deemix saves it for next time.
    pub fn login(&self, arl: &str) -> Result<Status, String> {
        let mut guard = self.server.lock().unwrap();
        let server = self.running(&mut guard)?;
        login(server, arl.trim())?;
        Ok(server.status.clone())
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<DeezerTrack>, String> {
        let mut guard = self.server.lock().unwrap();
        let server = self.running(&mut guard)?;
        // Ask for extra: the same recording often comes back once per release it's on.
        let nb = (limit * 2).to_string();
        let found = get(server, "search", &[("term", query), ("type", "track"), ("start", "0"), ("nb", &nb)])?;
        if let Some(e) = found["error"].as_str().filter(|e| !e.is_empty()) {
            return Err(format!("Deezer search failed: {e}"));
        }
        let mut tracks: Vec<DeezerTrack> = Vec::new();
        for t in found["data"].as_array().into_iter().flatten().filter_map(deezer_track) {
            // Keep the first (best ranked) of each artist + title + length.
            if !tracks.iter().any(|o| same_recording(o, &t)) {
                tracks.push(t);
            }
        }
        tracks.truncate(limit);
        Ok(tracks)
    }

    /// Queue a track or a whole album for download as FLAC.
    pub fn download(&self, kind: &str, id: u64) -> Result<(), String> {
        if kind != "track" && kind != "album" {
            return Err(format!("cannot download a {kind}"));
        }
        let mut guard = self.server.lock().unwrap();
        let server = self.running(&mut guard)?;
        let url = format!("https://www.deezer.com/{kind}/{id}");
        let reply = post(server, "addToQueue", json!({ "url": url, "bitrate": FLAC }))?;
        if reply["result"].as_bool() == Some(true) {
            return Ok(());
        }
        Err(match reply["errid"].as_str() {
            Some("NotLoggedIn") => "Not logged in to Deezer".into(),
            Some("CantStream") => "This Deezer account can't download FLAC".into(),
            Some(e) => format!("Deemix could not queue it ({e})"),
            None => "Deemix could not queue it".into(),
        })
    }

    /// Everything in the server's queue, finished or not (Deemix keeps finished downloads,
    /// including ones from earlier sessions). Empty if the server isn't running.
    pub fn queue(&self) -> Result<Vec<QueueItem>, String> {
        let mut guard = self.server.lock().unwrap();
        let Some(server) = guard.as_mut() else { return Ok(Vec::new()) };
        let q = get(server, "getQueue", &[])?;
        let current = &q["current"];
        // `queueOrder` only lists what is still to do; finished items are only in `queue`.
        let items = q["queue"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(uuid, item)| {
                // The running job has live counts; the queue entry only gets them when done.
                let live = if current["uuid"].as_str() == Some(uuid) { current } else { item };
                QueueItem {
                    uuid: uuid.to_owned(),
                    kind: item["type"].as_str().unwrap_or("track").to_owned(),
                    id: as_id(&item["id"]),
                    title: item["title"].as_str().unwrap_or_default().to_owned(),
                    artist: item["artist"].as_str().unwrap_or_default().to_owned(),
                    size: live["size"].as_u64().unwrap_or(0),
                    downloaded: live["downloaded"].as_u64().unwrap_or(0),
                    failed: live["failed"].as_u64().unwrap_or(0),
                    progress: live["progress"].as_f64().unwrap_or(0.0),
                    status: item["status"].as_str().unwrap_or("inQueue").to_owned(),
                    files: item["files"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|f| Some(DownloadedFile { track_id: as_id(&f["data"]["id"]), path: f["path"].as_str()?.to_owned() }))
                        .collect(),
                }
            })
            .collect();
        Ok(items)
    }

    pub fn shutdown(&self) {
        *self.server.lock().unwrap() = None;
        let _ = std::fs::remove_file(self.pid_file());
    }

    /// The running server, started (or restarted, if it died) as needed.
    fn running<'a>(&self, guard: &'a mut Option<Server>) -> Result<&'a mut Server, String> {
        if !cfg!(feature = "deezer") {
            return Err("This build doesn't include Deezer downloads".into());
        }
        if !self.installed() {
            let at = self.install.as_ref().map(|i| format!(" at {}", i.binary.display())).unwrap_or_default();
            return Err(format!("Deemix not found{at}"));
        }
        if guard.as_mut().is_some_and(|s| s.child.try_wait().ok().flatten().is_some()) {
            *guard = None;
        }
        if guard.is_none() {
            *guard = Some(self.start()?);
        }
        Ok(guard.as_mut().unwrap())
    }

    fn start(&self) -> Result<Server, String> {
        let install = self.install.as_ref().ok_or("Deemix not found")?;
        let music_dir = self.music_dir.lock().unwrap().clone().ok_or("Choose a library folder first: downloads go there")?;
        std::fs::create_dir_all(&self.data_dir).map_err(|e| format!("cannot create {}: {e}", self.data_dir.display()))?;
        self.kill_stale_server();
        self.sync_config(install, &music_dir)?;
        let port = TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .map_err(|e| format!("no free local port: {e}"))?
            .port();
        // Deemix appends file names straight onto these, so they need the trailing separator.
        let dir_arg = |p: &Path| format!("{}{}", p.display(), std::path::MAIN_SEPARATOR);
        let log_path = self.data_dir.join("server.log");
        let log = std::fs::File::create(&log_path).map_err(|e| format!("cannot write {}: {e}", log_path.display()))?;
        let child = background(Command::new(&install.binary))
            .arg(install.server_js())
            .args(["--host", "127.0.0.1", "--port", &port.to_string(), "--singleuser"])
            .env("ELECTRON_RUN_AS_NODE", "1")
            // Deemix ignores `--singleuser` (it reads `!!env ?? flag`, which never falls through),
            // so single-user mode, and with it the saved ARL, is switched on by this variable.
            .env("DEEMIX_SINGLE_USER", "1")
            .env("DEEMIX_DATA_DIR", dir_arg(&self.data_dir))
            .env("DEEMIX_MUSIC_DIR", dir_arg(&music_dir))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .map_err(|e| format!("cannot start Deemix: {e}"))?;
        let _ = std::fs::write(self.pid_file(), child.id().to_string());

        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(60)).build();
        let mut server = Server { child, base: format!("http://127.0.0.1:{port}/api/"), agent, status: self.base_status() };
        let started = Instant::now();
        loop {
            if get(&server, "getSettings", &[]).is_ok() {
                return Ok(server);
            }
            if let Ok(Some(code)) = server.child.try_wait() {
                let err = std::fs::read_to_string(&log_path).unwrap_or_default();
                let last = err.lines().last().unwrap_or("").trim().to_owned();
                return Err(format!("Deemix exited at start ({code}){}", if last.is_empty() { String::new() } else { format!(": {last}") }));
            }
            if started.elapsed() > STARTUP_TIMEOUT {
                return Err("Deemix did not start in time".into());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// Copy the GUI's settings (or keep ours if it has none) with downloads aimed at the library.
    fn sync_config(&self, install: &Install, music_dir: &Path) -> Result<(), String> {
        let ours = self.data_dir.join("config.json");
        let read = |p: &Path| std::fs::read(p).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).filter(Value::is_object);
        let Some(mut config) = read(&install.gui_config).or_else(|| read(&ours)) else {
            // No settings anywhere: Deemix writes its defaults, using DEEMIX_MUSIC_DIR as the folder.
            return Ok(());
        };
        config["downloadLocation"] = json!(music_dir.to_string_lossy());
        let bytes = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
        std::fs::write(&ours, bytes).map_err(|e| format!("cannot write {}: {e}", ours.display()))
    }

    fn pid_file(&self) -> PathBuf {
        self.data_dir.join("server.pid")
    }

    /// A server left running by a crashed previous session would keep downloading on its own.
    fn kill_stale_server(&self) {
        let Some(pid) = std::fs::read_to_string(self.pid_file()).ok().and_then(|s| s.trim().parse::<u32>().ok()) else { return };
        // Only if that process is still our server (the pid may have been reused since).
        #[cfg(unix)]
        {
            let command = Command::new("ps").args(["-p", &pid.to_string(), "-o", "command="]).output();
            if command.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(SERVER_JS)) {
                let _ = Command::new("kill").arg(pid.to_string()).status();
            }
        }
        // `tasklist` doesn't show command lines: the Deemix binary is close enough (the GUI itself
        // isn't started with our pid file).
        #[cfg(windows)]
        {
            let filter = format!("PID eq {pid}");
            let command = background(Command::new("tasklist")).args(["/FI", &filter, "/FO", "CSV", "/NH"]).output();
            if command.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).to_ascii_lowercase().contains("deemix-gui.exe")) {
                let _ = background(Command::new("taskkill")).args(["/PID", &pid.to_string(), "/F"]).status();
            }
        }
    }
}

/// A command run without a console window popping up.
#[cfg(windows)]
fn background(mut command: Command) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
fn background(command: Command) -> Command {
    command
}

fn login(server: &mut Server, arl: &str) -> Result<(), String> {
    if arl.is_empty() {
        return Err("Paste your Deezer ARL first".into());
    }
    let reply = post(server, "loginArl", json!({ "arl": arl }))?;
    match reply["status"].as_i64() {
        Some(1..=3) => {
            server.status = logged_in_status(&reply["user"], &server.status);
            Ok(())
        }
        Some(-1) => Err("Deezer is not reachable".into()),
        _ => Err("Deezer rejected this ARL".into()),
    }
}

fn logged_in_status(user: &Value, before: &Status) -> Status {
    Status {
        available: before.available,
        installed: true,
        location: before.location.clone(),
        logged_in: true,
        user: user["name"].as_str().map(str::to_owned),
        lossless: user["can_stream_lossless"].as_bool().unwrap_or(true),
    }
}

fn deezer_track(t: &Value) -> Option<DeezerTrack> {
    Some(DeezerTrack {
        id: as_id(&t["id"]),
        title: t["title"].as_str()?.to_owned(),
        artist: t["artist"]["name"].as_str().unwrap_or_default().to_owned(),
        album: t["album"]["title"].as_str().unwrap_or_default().to_owned(),
        album_id: as_id(&t["album"]["id"]),
        duration: t["duration"].as_f64().unwrap_or(0.0),
        cover: t["album"]["cover_small"].as_str().map(str::to_owned),
    })
}

fn same_recording(a: &DeezerTrack, b: &DeezerTrack) -> bool {
    a.artist.to_lowercase() == b.artist.to_lowercase() && a.title.to_lowercase() == b.title.to_lowercase() && (a.duration - b.duration).abs() <= 2.0
}

/// Deezer ids come as numbers or strings depending on the endpoint.
fn as_id(v: &Value) -> u64 {
    v.as_u64().or_else(|| v.as_str()?.parse().ok()).unwrap_or(0)
}

fn get(server: &Server, path: &str, query: &[(&str, &str)]) -> Result<Value, String> {
    let mut request = server.agent.get(&format!("{}{path}", server.base));
    for (k, v) in query {
        request = request.query(k, v);
    }
    request.call().map_err(http_error)?.into_json().map_err(|e| format!("bad reply from Deemix: {e}"))
}

fn post(server: &Server, path: &str, body: Value) -> Result<Value, String> {
    server
        .agent
        .post(&format!("{}{path}", server.base))
        .send_json(body)
        .map_err(http_error)?
        .into_json()
        .map_err(|e| format!("bad reply from Deemix: {e}"))
}

fn http_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, _) => format!("Deemix replied {code}"),
        ureq::Error::Transport(t) => format!("cannot reach Deemix: {t}"),
    }
}
