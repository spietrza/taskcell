fn main() {
    // The server switcher's commands are the only app commands: capabilities/hub.json grants them to the
    // loopback UI, servers::grant to each saved server's own origin at runtime.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "servers_list",
            "servers_add",
            "servers_remove",
            "servers_switch",
        ])),
    )
    .expect("failed to run tauri-build");
}
