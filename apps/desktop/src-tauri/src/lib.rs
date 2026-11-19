//! The desktop shell: opens the window and starts/stops the local hub (`hub.rs`). Every product
//! feature runs in the hub; the UI reaches it over the hub API. The only Tauri commands are the server
//! switcher's (`servers.rs`): which hub, local or a saved remote one, the window shows.

mod hub;
mod servers;

use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, SubmenuBuilder};
use tauri::RunEvent;

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
        .invoke_handler(tauri::generate_handler![
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
