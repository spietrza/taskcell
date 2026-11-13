//! Starts, supervises and stops the local hub (`taskcell hub`) — the app's only backend. The window
//! shows a splash page until the hub prints its launch URL, then navigates to it: from there the UI
//! talks to the hub over its HTTP API, exactly like a browser pointed at the same hub.

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::servers;

const WINDOW: &str = "main";
/// The hub prints `Vanguard Hub → <launch URL>` once it listens (src/cli/hub.ts).
const URL_PREFIX: &str = "Vanguard Hub → ";
/// A hub that dies this soon after start counts as a failed start, not a crash of a healthy hub.
const HEALTHY_AFTER: Duration = Duration::from_secs(10);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// Owns the one hub child. `started` makes `start` idempotent so the supervisor never runs twice.
#[derive(Default)]
pub struct Hub {
    started: AtomicBool,
    stopping: AtomicBool,
    child: Mutex<Option<Child>>,
    /// The local hub's launch URL once it printed it (so switching back to Local needs no restart).
    local_url: Mutex<Option<String>>,
    /// The saved server the window shows (`None` = the local hub).
    active: Mutex<Option<String>>,
    /// Bumped on every switch; a reconnect loop of an older generation ends itself, so one switch
    /// never leaves two loops navigating the window.
    generation: AtomicU64,
}

/// How to launch the hub. A bundled install runs its own Node runtime (the `node` sidecar next to the
/// app binary) on the bundled CLI; a source checkout runs the TypeScript CLI through `tsx`.
struct Launch {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
}

/// The checkout root when running from source (`pnpm start`); fixed at compile time.
fn source_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn node_program() -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("node"))
}

fn launch_for(app: &AppHandle) -> Result<Launch, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("taskcell");
    let cli = bundled.join("dist/cli/index.js");
    if cli.exists() {
        return Ok(Launch { program: node_program(), args: vec![cli.to_string_lossy().into_owned()], cwd: bundled });
    }
    let root = source_root();
    let script = root.join("src/cli/index.ts");
    if script.exists() {
        return Ok(Launch {
            program: PathBuf::from("node"),
            args: vec!["--import".into(), "tsx".into(), script.to_string_lossy().into_owned()],
            cwd: root,
        });
    }
    Err("no hub found: neither the bundled taskcell hub nor a source checkout is available".into())
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    listener.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

fn spawn_hub(app: &AppHandle) -> Result<Child, String> {
    let launch = launch_for(app)?;
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let port = free_port()?;
    Command::new(&launch.program)
        .args(&launch.args)
        .args(["hub", "--host", "127.0.0.1", "--port", &port.to_string(), "--no-open", "--repo"])
        .arg(&config_dir)
        .current_dir(&launch.cwd)
        // The app's own hub: projects live where the app always kept them, Fleet is on (loopback only),
        // and the hub exits when this process dies (stdin EOF) so it can never be orphaned.
        .env("VANGUARD_HUB_CONFIG_DIR", &config_dir)
        .env("VANGUARD_HUB_ALLOW_FLEET", "1")
        .env("VANGUARD_HUB_EXIT_ON_STDIN_EOF", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("start {}: {e}", launch.program.display()))
}

fn js_string(s: &str) -> String {
    serde_json::Value::String(s.to_string()).to_string()
}

fn eval(app: &AppHandle, script: &str) {
    if let Some(win) = app.get_webview_window(WINDOW) {
        let _ = win.eval(script);
    }
}

/// Shown over whatever the window currently displays (the splash, or the hub page of a dead hub).
fn show_status(app: &AppHandle, message: &str) {
    let msg = js_string(message);
    eval(
        app,
        &format!(
            "(function(m){{var e=document.getElementById('vanguard-hub-status');\
             if(!e){{e=document.createElement('div');e.id='vanguard-hub-status';\
             e.setAttribute('role','alert');\
             e.style.cssText='position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;\
             justify-content:center;background:#0b0b0c;color:#e8e8ea;font:15px system-ui,sans-serif;\
             text-align:center;padding:2rem';document.body.appendChild(e);}}e.textContent=m;}})({msg})"
        ),
    );
}

fn open_hub(app: &AppHandle, url: &str) {
    eval(app, &format!("window.location.replace({})", js_string(url)));
}

/// Read the hub's stdout until it prints the launch URL (then keep draining so the pipe never fills).
fn read_launch_url(child: &mut Child) -> Option<String> {
    let stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    thread::spawn(move || {
        let mut sent = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !sent {
                if let Some(url) = line.strip_prefix(URL_PREFIX) {
                    sent = true;
                    let _ = tx.send(url.trim().to_string());
                }
            }
        }
    });
    rx.recv_timeout(Duration::from_secs(60)).ok()
}

impl Hub {
    /// Start the supervisor once: launch the hub, point the window at it, restart it when it dies.
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let hub = Arc::clone(self);
        thread::spawn(move || hub.supervise(&app));
    }

    fn supervise(&self, app: &AppHandle) {
        let mut backoff = Duration::from_secs(1);
        while !self.stopping.load(Ordering::SeqCst) {
            let began = Instant::now();
            match spawn_hub(app) {
                Ok(mut child) => {
                    let url = read_launch_url(&mut child);
                    *self.child.lock().unwrap() = Some(child);
                    match url {
                        Some(url) if !self.stopping.load(Ordering::SeqCst) => {
                            *self.local_url.lock().unwrap() = Some(url.clone());
                            if self.active().is_none() {
                                open_hub(app, &url);
                            }
                        }
                        Some(_) => {}
                        None => self.local_status(app, "The hub did not start — retrying…"),
                    }
                    self.wait_for_exit();
                }
                Err(e) => self.local_status(app, &format!("Cannot start the hub: {e}")),
            }
            if self.stopping.load(Ordering::SeqCst) {
                break;
            }
            if began.elapsed() >= HEALTHY_AFTER {
                backoff = Duration::from_secs(1);
            }
            *self.local_url.lock().unwrap() = None;
            self.local_status(app, "The hub stopped — restarting…");
            thread::sleep(backoff);
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }

    /// The saved server the window shows, or `None` for the local hub.
    pub fn active(&self) -> Option<String> {
        self.active.lock().unwrap().clone()
    }

    /// Local-hub status text is only for the window while it shows the local hub.
    fn local_status(&self, app: &AppHandle, message: &str) {
        if self.active().is_none() {
            show_status(app, message);
        }
    }

    /// Show the local hub (`None`) or a saved server without restarting anything. The local hub keeps
    /// running in the background. A server gets one reconnect loop (`follow`); switching again ends it.
    pub fn switch(self: &Arc<Self>, app: &AppHandle, id: Option<String>) -> Result<(), String> {
        let server = match &id {
            None => None,
            Some(id) => {
                let dir = servers::config_dir(app)?;
                Some(servers::load(&dir)?.into_iter().find(|s| &s.id == id).ok_or("Unknown server")?)
            }
        };
        // Generation and active change together under the lock `follow` acts under, so a stale loop
        // can never navigate or overlay the window after this returns.
        let generation = {
            let mut active = self.active.lock().unwrap();
            *active = id;
            self.generation.fetch_add(1, Ordering::SeqCst) + 1
        };
        match server {
            None => {
                // Not up yet: the supervisor navigates when it is (it checks `active`).
                if let Some(url) = self.local_url.lock().unwrap().clone() {
                    open_hub(app, &url);
                }
            }
            Some(server) => {
                let hub = Arc::clone(self);
                let app = app.clone();
                thread::spawn(move || hub.follow(&app, generation, &server));
            }
        }
        Ok(())
    }

    fn current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation && !self.stopping.load(Ordering::SeqCst)
    }

    /// Open `server` once it answers, then watch it: when it goes away say so, and when it comes back
    /// load it again. Only ever navigates the window (never replays a request), so nothing a run
    /// started is started twice; the generation check keeps a stale loop from touching the window.
    fn follow(&self, app: &AppHandle, generation: u64, server: &servers::Server) {
        let target = format!("{}/", server.url);
        let mut up = false;
        let mut shown = false;
        let mut misses = 0;
        while self.current(generation) {
            let now_up = servers::reachable(&server.url);
            // One failed probe is a blip, not an outage: it would blank and reload a healthy page.
            misses = if now_up { 0 } else { misses + 1 };
            let down = !now_up && (misses >= 2 || !up);
            // Probing blocks, so re-check under the lock `switch` holds before touching the window.
            let _guard = self.active.lock().unwrap();
            if self.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            if now_up && !up {
                open_hub(app, &target);
                shown = true;
                up = true;
            } else if down && (up || !shown) {
                let msg = if up { "Lost connection to" } else { "Cannot reach" };
                show_status(
                    app,
                    &format!("{msg} {} — reconnecting… (Server menu ▸ Switch to Local Hub, or Ctrl/Cmd+Shift+L)", server.name),
                );
                shown = true;
                up = false;
            }
            drop(_guard);
            thread::sleep(Duration::from_secs(if up { 5 } else { 2 }));
        }
    }

    /// Block until the child exits (or `stop` takes it). Polls so `stop` can kill it concurrently.
    fn wait_for_exit(&self) {
        loop {
            thread::sleep(Duration::from_millis(250));
            let mut guard = self.child.lock().unwrap();
            match guard.as_mut().map(|c| c.try_wait()) {
                Some(Ok(None)) => {}
                _ => {
                    *guard = None;
                    return;
                }
            }
        }
    }

    /// Quit: stop restarting and take the hub down — gracefully first (it closes its listener and
    /// ends the runs it spawned), forcefully after a grace period.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let Some(mut child) = self.child.lock().unwrap().take() else { return };
        drop(child.stdin.take()); // EOF on stdin = "parent is gone": the hub shuts itself down
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_string_escapes_quotes_and_scripts() {
        assert_eq!(js_string("a\"b"), "\"a\\\"b\"");
        assert!(!js_string("</script>").contains('\n'));
    }

    #[test]
    fn free_port_is_bindable_again() {
        let port = free_port().unwrap();
        assert!(port > 0);
        assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
    }

    #[test]
    fn start_is_idempotent() {
        let hub = Hub::default();
        assert!(!hub.started.swap(true, Ordering::SeqCst));
        assert!(hub.started.swap(true, Ordering::SeqCst));
    }
}
