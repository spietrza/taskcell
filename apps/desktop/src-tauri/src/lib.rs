//! The desktop shell: opens the window and starts/stops the local hub (`hub.rs`). Every product
//! feature runs in the hub; the UI reaches it over the hub API, so there are no Tauri commands here.

mod hub;

use std::sync::Arc;
use tauri::RunEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hub = Arc::new(hub::Hub::default());
    let app = tauri::Builder::default()
        .setup({
            let hub = Arc::clone(&hub);
            move |app| {
                hub.start(app.handle().clone());
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(move |_handle, event| {
        if let RunEvent::Exit = event {
            hub.stop();
        }
    });
}
