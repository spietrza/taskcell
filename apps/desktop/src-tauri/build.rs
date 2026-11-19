fn main() {
    // The server switcher's commands are the only app commands: servers::grant_local grants them to the
    // local hub's exact launch origin, servers::grant list/switch to each saved server's own origin (runtime).
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
