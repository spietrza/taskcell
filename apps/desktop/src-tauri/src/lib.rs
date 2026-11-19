//! The desktop shell: opens the window and starts/stops the local hub (`hub.rs`). Every product
//! feature runs in the hub; the UI reaches it over the hub API. The only Tauri commands are the server
//! switcher's (`servers.rs`): which hub, local or a saved remote one, the window shows.

mod hub;
mod servers;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, SubmenuBuilder};
use tauri::{Manager, RunEvent, State, WindowEvent};

/// A user-initiated window close the page has not finished yet: the origin the window showed when it
/// was requested, when, and whether the page took it over (`hold_close`). Lets a saved server's page,
/// which may not call `destroy` (servers::grant), finish the close after its discard prompt and write
/// flush (`close_window`) — and only then.
#[derive(Default)]
struct PendingClose(Mutex<Option<(String, Instant, bool)>>);

/// Long enough for the discard prompt and the bounded flush; a stale request cannot close later.
const CLOSE_GRACE: Duration = Duration::from_secs(60);

/// A remote hub serving an older UI cannot finish a close (no `destroy`, no `close_window`): unless its
/// page holds, cancels or finishes the close by then, the app closes the window itself — a few seconds
/// past the page's 2 s flush budget.
const CLOSE_FALLBACK: Duration = Duration::from_secs(5);

/// Finishes a pending user-initiated close for the page that showed when it was requested. One-shot:
/// without a pending close (or from another origin) it refuses, so a remote hub cannot close at will.
#[tauri::command]
fn close_window(webview: tauri::Webview, pending: State<'_, PendingClose>) -> Result<(), String> {
    let origin = servers::page_origin(webview.url());
    let request = pending.0.lock().unwrap().take();
    match request {
        Some((o, at, _)) if Some(&o) == origin.as_ref() && at.elapsed() < CLOSE_GRACE => {
            webview.window().destroy().map_err(|e| e.to_string())
        }
        _ => Err("No close request pending for this page".into()),
    }
}

/// The page handles the pending close itself: `cancel` drops it (the user kept the page), otherwise it
/// stays pending for `close_window` but the native fallback (`CLOSE_FALLBACK`) no longer fires.
#[tauri::command]
fn hold_close(webview: tauri::Webview, pending: State<'_, PendingClose>, cancel: bool) {
    let origin = servers::page_origin(webview.url());
    let mut request = pending.0.lock().unwrap();
    let Some((o, _, held)) = request.as_mut() else { return };
    if Some(&*o) != origin.as_ref() {
        return;
    }
    if cancel {
        *request = None;
    } else {
        *held = true;
    }
}

/// An update downloaded on consent, installed only after the hub has stopped (see `run`).
#[cfg(desktop)]
type PendingUpdate = Arc<std::sync::Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>>;

/// True once `plugins.updater.pubkey` is a real key; the placeholder means "updates not set up yet".
#[cfg(desktop)]
fn updater_configured(app: &tauri::AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.starts_with("REPLACE_"))
}

/// Checks the update manifest once on start and offers the new version. On consent it only
/// downloads: installing replaces the running app (on Windows it also exits it), which would end
/// in-flight runs, so the install happens on quit, after `hub.stop()` (see `install_pending`).
/// Offline or no manifest: silent. A failed download after consent is reported.
#[cfg(desktop)]
fn check_for_update(app: tauri::AppHandle, pending: PendingUpdate) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    use tauri_plugin_updater::UpdaterExt;
    if !updater_configured(&app) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater() else { return };
        let Ok(Some(update)) = updater.check().await else { return };
        let ask = app
            .dialog()
            .message(format!(
                "Taskcell {} is available. Download it now? It is installed when you quit Taskcell; running tasks are not interrupted.",
                update.version
            ))
            .title("Update available")
            .buttons(MessageDialogButtons::OkCancelCustom("Download".into(), "Later".into()));
        let yes = tauri::async_runtime::spawn_blocking(move || ask.blocking_show()).await.unwrap_or(false);
        if !yes {
            return;
        }
        let msg = match update.download(|_, _| {}, || {}).await {
            Ok(bytes) => {
                *pending.lock().unwrap() = Some((update, bytes));
                "Update downloaded. It will be installed when you quit Taskcell.".to_string()
            }
            Err(e) => format!("Update failed: {e}"),
        };
        app.dialog().message(msg).title("Taskcell update").show(|_| {});
    });
}

/// Installs a downloaded update. Runs on exit after `hub.stop()`, so no run is in flight.
#[cfg(desktop)]
fn install_pending(pending: &PendingUpdate) {
    let Some((update, bytes)) = pending.lock().unwrap().take() else { return };
    if let Err(e) = update.install(bytes) {
        eprintln!("taskcell: update install failed: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hub = Arc::new(hub::Hub::default());
    #[cfg(desktop)]
    let pending: PendingUpdate = Arc::default();
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .manage(Arc::clone(&hub))
        .manage(PendingClose::default())
        // The page's close handler still runs (discard prompt, write flush) and finishes the close;
        // record the request so a saved server's page can finish it through `close_window`.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let origin = window.get_webview_window(window.label()).and_then(|w| servers::page_origin(w.url()));
                let at = Instant::now();
                let remote = origin.is_some() && origin != window.state::<Arc<hub::Hub>>().local_origin();
                *window.state::<PendingClose>().0.lock().unwrap() = origin.map(|o| (o, at, false));
                if remote {
                    // Only this request, and only if the page neither held, cancelled nor finished it.
                    let window = window.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(CLOSE_FALLBACK);
                        let state = window.state::<PendingClose>();
                        let mut request = state.0.lock().unwrap();
                        if request.as_ref().is_some_and(|&(_, a, held)| a == at && !held) {
                            *request = None;
                            drop(request);
                            let _ = window.destroy();
                        }
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            close_window,
            hold_close,
            servers::servers_list,
            servers::servers_add,
            servers::servers_remove,
            servers::servers_switch
        ])
        .setup({
            let hub = Arc::clone(&hub);
            #[cfg(desktop)]
            let pending = Arc::clone(&pending);
            move |app| {
                servers::grant_saved(app.handle());
                // The way back to Local from any page — including one without the rail (a sign-in
                // page, a proxy error), where the in-app switcher is not available.
                let local = MenuItem::with_id(app.handle(), "server-local", "Switch to Local Hub", true, Some("CmdOrCtrl+Shift+L"))?;
                let submenu = SubmenuBuilder::new(app.handle(), "Server").item(&local).build()?;
                let menu = Menu::default(app.handle())?;
                menu.append(&submenu)?;
                app.set_menu(menu)?;
                let menu_hub = Arc::clone(&hub);
                app.on_menu_event(move |handle, event| {
                    if event.id() == "server-local" {
                        let _ = menu_hub.switch(handle, None);
                    }
                });
                hub.start(app.handle().clone());
                #[cfg(desktop)]
                check_for_update(app.handle().clone(), pending);
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_handle, event| {
            if let RunEvent::Exit = event {
                hub.stop();
                #[cfg(desktop)]
                install_pending(&pending);
            }
        });
}
