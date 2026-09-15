use devtools_plugin_discovery::discover;
use serde::Serialize;
use std::{env, fs, path::PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddedPlugin {
    id: String,
    version: String,
    manifest: String,
    processor: String,
    frontend: Option<String>,
    operation_ids: Vec<String>,
}

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let plugins = manifest_dir.join("../../../plugins");
    let discovered = discover(&plugins).expect("trusted bundled plugin discovery must pass before the desktop build");
    let entries = discovered.into_iter().map(|package| {
        let name = package.root.file_name().and_then(|value| value.to_str()).unwrap_or_default();
        EmbeddedPlugin {
            id: package.manifest.id,
            version: package.manifest.version,
            manifest: format!("{name}/{}", package.descriptor.manifest),
            processor: format!("{name}/{}", package.descriptor.processor.unwrap_or_default()),
            frontend: package.descriptor.frontend.map(|path| format!("{name}/{path}")),
            operation_ids: package.manifest.operations.into_iter().map(|operation| operation.id).collect(),
        }
    }).collect::<Vec<_>>();
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    fs::write(out.join("plugin_catalog.json"), serde_json::to_vec_pretty(&entries).expect("plugin catalog serializes"))
        .expect("write embedded plugin catalog");
    println!("cargo:rerun-if-changed={}", plugins.display());
    tauri_build::build()
}
