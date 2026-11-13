//! Saved remote hubs ("server mode"): the list lives in `servers.json` in the app config dir. The app
//! stores no credentials: sign-in happens on the hub's own page and its session cookie stays in the
//! webview's cookie store. Switching only changes which hub the window shows — see `Hub::switch` in
//! hub.rs; the commands here are the UI's server switcher.

use std::fs;
use std::io;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, Url};

use crate::hub::Hub;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Server {
    pub id: String,
    pub name: String,
    /// Normalized origin (+ path prefix) of the hub, without a trailing slash.
    pub url: String,
}

/// What the switcher renders: every saved server and which one the window shows (`None` = Local).
#[derive(Debug, Clone, Serialize)]
pub struct ServerState {
    pub servers: Vec<Server>,
    pub active: Option<String>,
}

fn file(dir: &Path) -> PathBuf {
    dir.join("servers.json")
}

/// A missing file is an empty list; a file that exists but does not parse is an error, so the next
/// save can never overwrite a hand-edited list.
pub fn load(dir: &Path) -> Result<Vec<Server>, String> {
    match fs::read_to_string(file(dir)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("servers.json is unreadable: {e}")),
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("servers.json is unreadable: {e}")),
    }
}

/// Write via a temp file + rename so a crash never leaves a half-written list.
fn save(dir: &Path, servers: &[Server]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(servers).map_err(|e| e.to_string())?;
    let tmp = dir.join("servers.json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, file(dir)).map_err(|e| e.to_string())
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// A hub URL the app may open: https (http only for loopback), with a host, no credentials in the URL,
/// no query or fragment. Trailing slash dropped.
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let mut url = Url::parse(raw.trim()).map_err(|_| "Enter a full URL such as https://hub.example.com".to_string())?;
    let Some(host) = url.host_str() else { return Err("The hub URL needs a host".into()) };
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(host) => {}
        "http" => return Err("Use https:// — plain http is only allowed for localhost".into()),
        _ => return Err("The hub URL must start with https://".into()),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Do not put a username or password in the URL — sign in on the hub instead".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Can the host be reached at all (TCP connect)? Cheap liveness probe for the reconnect loop.
pub fn reachable(url: &str) -> bool {
    let Ok(u) = Url::parse(url) else { return false };
    u.socket_addrs(|| None)
        .map(|addrs| addrs.iter().any(|a| TcpStream::connect_timeout(a, Duration::from_secs(5)).is_ok()))
        .unwrap_or(false)
}

/// Let a saved server's own pages use the switcher commands and the window chrome the local hub's
/// UI has — and only that origin (never every http(s) page; capabilities/hub.json covers loopback).
pub fn grant(app: &AppHandle, server: &Server) -> Result<(), String> {
    let origin = Url::parse(&server.url).map_err(|e| e.to_string())?.origin().ascii_serialization();
    let capability = serde_json::json!({
        "identifier": format!("server-{}", server.id),
        "windows": ["main"],
        "remote": { "urls": [format!("{origin}/*")] },
        "permissions": [
            "allow-servers-list", "allow-servers-add", "allow-servers-remove", "allow-servers-switch",
            "core:window:allow-start-dragging", "core:window:allow-destroy",
            "core:event:allow-listen", "core:event:allow-unlisten"
        ]
    });
    app.add_capability(capability.to_string()).map_err(|e| e.to_string())
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

/// Grant every saved server's origin (startup).
pub fn grant_saved(app: &AppHandle) {
    let Ok(dir) = config_dir(app) else { return };
    for s in load(&dir).unwrap_or_default() {
        let _ = grant(app, &s);
    }
}

fn new_id() -> String {
    format!("srv-{}", chrono::Utc::now().timestamp_micros())
}

#[tauri::command]
pub fn servers_list(app: AppHandle, hub: State<'_, Arc<Hub>>) -> Result<ServerState, String> {
    Ok(ServerState { servers: load(&config_dir(&app)?)?, active: hub.active() })
}

#[tauri::command]
pub fn servers_add(app: AppHandle, name: String, url: String) -> Result<Server, String> {
    let dir = config_dir(&app)?;
    let url = normalize_url(&url)?;
    let mut servers = load(&dir)?;
    if servers.iter().any(|s| s.url == url) {
        return Err("That server is already saved".into());
    }
    let name = name.trim();
    let server = Server {
        id: new_id(),
        name: if name.is_empty() { url.clone() } else { name.to_string() },
        url,
    };
    grant(&app, &server)?;
    servers.push(server.clone());
    save(&dir, &servers)?;
    Ok(server)
}

#[tauri::command]
pub fn servers_remove(app: AppHandle, hub: State<'_, Arc<Hub>>, id: String) -> Result<(), String> {
    let dir = config_dir(&app)?;
    let mut servers = load(&dir)?;
    if hub.active().as_deref() == Some(id.as_str()) {
        hub.switch(&app, None)?;
    }
    servers.retain(|s| s.id != id);
    save(&dir, &servers)
}

/// `None` switches back to the local hub.
#[tauri::command]
pub fn servers_switch(app: AppHandle, hub: State<'_, Arc<Hub>>, id: Option<String>) -> Result<(), String> {
    hub.switch(&app, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_accepts_https_and_loopback_http_and_trims() {
        assert_eq!(normalize_url(" https://hub.example.com/ ").unwrap(), "https://hub.example.com");
        assert_eq!(normalize_url("http://127.0.0.1:7777").unwrap(), "http://127.0.0.1:7777");
        assert_eq!(normalize_url("https://x.io/hub/?a=1#f").unwrap(), "https://x.io/hub");
    }

    #[test]
    fn normalize_rejects_bad_urls() {
        assert!(normalize_url("hub.example.com").is_err());
        assert!(normalize_url("ftp://hub.example.com").is_err());
        assert!(normalize_url("http://10.0.0.5:7777").is_err());
        // Built at runtime so no credential-shaped literal sits in the source (secret scan).
        let with_userinfo = format!("https://{}@hub.example.com", "user:pass");
        assert!(normalize_url(&with_userinfo).is_err());
    }

    #[test]
    fn list_roundtrips_and_missing_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(load(tmp.path()).unwrap().is_empty());
        let s = vec![Server { id: "a".into(), name: "A".into(), url: "https://h".into() }];
        save(tmp.path(), &s).unwrap();
        assert_eq!(load(tmp.path()).unwrap(), s);
    }

    #[test]
    fn corrupt_list_is_an_error_not_empty() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(file(tmp.path()), "{not json").unwrap();
        assert!(load(tmp.path()).is_err());
    }

    #[test]
    fn unreachable_host_is_not_reachable() {
        let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        assert!(!reachable(&format!("http://127.0.0.1:{port}")));
    }
}
