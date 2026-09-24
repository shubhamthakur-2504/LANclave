fn main() {
    // tauri-build only embeds its Windows manifest into the app binary, so
    // `cargo test` executables load comctl32 v5, miss `TaskDialogIndirect`,
    // and die with STATUS_ENTRYPOINT_NOT_FOUND before a single test runs.
    // Embed the manifest ourselves via a link arg, which Cargo also applies
    // to test targets.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();

    if target_os == "windows" && target_env == "msvc" {
        let attrs = tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new_without_app_manifest(),
        );
        tauri_build::try_build(attrs).expect("tauri-build failed");

        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed=windows-app-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    } else {
        tauri_build::build()
    }
}
