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

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

const APP: &str = "/Applications/deemix-gui.app";
const BINARY: &str = "Contents/MacOS/deemix-gui";
const SERVER_JS: &str = "Contents/Resources/app.asar/server/dist/app.js";
/// The Deemix GUI's settings, copied into our server's data folder on start.
const GUI_CONFIG: &str = "Library/Application Support/deemix/config.json";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
/// Deemix's code for FLAC.
const FLAC: u32 = 9;

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
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

pub struct Deemix {
    app: PathBuf,
    data_dir: PathBuf,
    music_dir: PathBuf,
    gui_config: PathBuf,
    server: Mutex<Option<Server>>,
}

impl Deemix {
    pub fn new(home: &Path, data_dir: PathBuf, music_dir: PathBuf) -> Self {
        Deemix { app: PathBuf::from(APP), data_dir, music_dir, gui_config: home.join(GUI_CONFIG), server: Mutex::new(None) }
    }

    fn installed(&self) -> bool {
        self.app.join(BINARY).is_file()
    }

    /// Start the server if needed and log in with the saved ARL if there is one.
    pub fn connect(&self) -> Result<Status, String> {
        if !self.installed() {
            return Ok(Status::default());
        }
        let mut guard = self.server.lock().unwrap();
        let server = self.running(&mut guard)?;
        if !server.status.logged_in {
            let connect = get(server, "connect", &[])?;
            if let Some(arl) = connect["singleUser"]["arl"].as_str().filter(|a| !a.is_empty()) {
                // A rejected saved ARL just leaves us logged out; the user can paste a new one.
                let _ = login(server, arl);
            } else if !connect["autologin"].as_bool().unwrap_or(true) {
                server.status = logged_in_status(&connect["currentUser"]);
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
        if !self.installed() {
            return Err(format!("Deemix not found at {APP}"));
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
        std::fs::create_dir_all(&self.data_dir).map_err(|e| format!("cannot create {}: {e}", self.data_dir.display()))?;
        self.kill_stale_server();
        self.sync_config()?;
        let port = TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .map_err(|e| format!("no free local port: {e}"))?
            .port();
        // Deemix appends file names straight onto these, so they need the trailing slash.
        let dir_arg = |p: &Path| format!("{}/", p.display());
        let log_path = self.data_dir.join("server.log");
        let log = std::fs::File::create(&log_path).map_err(|e| format!("cannot write {}: {e}", log_path.display()))?;
        let child = Command::new(self.app.join(BINARY))
            .arg(self.app.join(SERVER_JS))
            .args(["--host", "127.0.0.1", "--port", &port.to_string(), "--singleuser"])
            .env("ELECTRON_RUN_AS_NODE", "1")
            .env("DEEMIX_DATA_DIR", dir_arg(&self.data_dir))
            .env("DEEMIX_MUSIC_DIR", dir_arg(&self.music_dir))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .map_err(|e| format!("cannot start Deemix: {e}"))?;
        let _ = std::fs::write(self.pid_file(), child.id().to_string());

        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(60)).build();
        let mut server = Server { child, base: format!("http://127.0.0.1:{port}/api/"), agent, status: Status::default() };
        server.status.installed = true;
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
    fn sync_config(&self) -> Result<(), String> {
        let ours = self.data_dir.join("config.json");
        let read = |p: &Path| std::fs::read(p).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).filter(Value::is_object);
        let Some(mut config) = read(&self.gui_config).or_else(|| read(&ours)) else {
            // No settings anywhere: Deemix writes its defaults, using DEEMIX_MUSIC_DIR as the folder.
            return Ok(());
        };
        config["downloadLocation"] = json!(self.music_dir.to_string_lossy());
        let bytes = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
        std::fs::write(&ours, bytes).map_err(|e| format!("cannot write {}: {e}", ours.display()))
    }

    fn pid_file(&self) -> PathBuf {
        self.data_dir.join("server.pid")
    }

    /// A server left running by a crashed previous session would keep downloading on its own.
    fn kill_stale_server(&self) {
        let Some(pid) = std::fs::read_to_string(self.pid_file()).ok().and_then(|s| s.trim().parse::<u32>().ok()) else { return };
        let command = Command::new("ps").args(["-p", &pid.to_string(), "-o", "command="]).output();
        if command.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(SERVER_JS)) {
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
    }
}

fn login(server: &mut Server, arl: &str) -> Result<(), String> {
    if arl.is_empty() {
        return Err("Paste your Deezer ARL first".into());
    }
    let reply = post(server, "loginArl", json!({ "arl": arl }))?;
    match reply["status"].as_i64() {
        Some(1..=3) => {
            server.status = logged_in_status(&reply["user"]);
            Ok(())
        }
        Some(-1) => Err("Deezer is not reachable".into()),
        _ => Err("Deezer rejected this ARL".into()),
    }
}

fn logged_in_status(user: &Value) -> Status {
    Status {
        installed: true,
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
