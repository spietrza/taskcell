//! The desktop shell: opens the window and starts/stops the local hub (`hub.rs`). Every product
//! feature runs in the hub; the UI reaches it over the hub API. The only Tauri commands are the server
//! switcher's (`servers.rs`): which hub, local or a saved remote one, the window shows.

mod hub;
mod servers;

use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, SubmenuBuilder};
use tauri::RunEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hub = Arc::new(hub::Hub::default());
    let app = tauri::Builder::default()
        .manage(Arc::clone(&hub))
        .invoke_handler(tauri::generate_handler![
            servers::servers_list,
            servers::servers_add,
            servers::servers_remove,
            servers::servers_switch
        ])
        .setup({
            let hub = Arc::clone(&hub);
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
