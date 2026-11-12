//! The desktop shell: opens the window and starts/stops the local hub (`hub.rs`). Every product
//! feature runs in the hub; the UI reaches it over the hub API, so there are no Tauri commands here.

mod hub;

use std::sync::Arc;
use tauri::RunEvent;

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

/// Checks the update manifest once on start and offers the new version. The update is installed
/// but never restarts the app (a run may be in flight); the user restarts when ready.
/// Offline or no manifest: silent. A failed install after consent is reported.
#[cfg(desktop)]
fn check_for_update(app: tauri::AppHandle) {
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
            .message(format!("Taskcell {} is available. Install it now? Restart Taskcell afterwards to use it.", update.version))
            .title("Update available")
            .buttons(MessageDialogButtons::OkCancelCustom("Update".into(), "Later".into()));
        let yes = tauri::async_runtime::spawn_blocking(move || ask.blocking_show()).await.unwrap_or(false);
        if !yes {
            return;
        }
        let msg = match update.download_and_install(|_, _| {}, || {}).await {
            Ok(()) => "Update installed. Restart Taskcell to use the new version.".to_string(),
            Err(e) => format!("Update failed: {e}"),
        };
        app.dialog().message(msg).title("Taskcell update").show(|_| {});
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hub = Arc::new(hub::Hub::default());
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .setup({
            let hub = Arc::clone(&hub);
            move |app| {
                hub.start(app.handle().clone());
                #[cfg(desktop)]
                check_for_update(app.handle().clone());
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_handle, event| {
            if let RunEvent::Exit = event {
                hub.stop();
            }
        });
}
