//! Deterministic discovery and build-time composition for trusted bundled plugins.
//! Runtime installation is intentionally outside this package.

use devtools_plugin_contract::{parse_manifest, PluginManifest};
use serde::{Deserialize, Serialize};
use std::{fs, path::{Component, Path, PathBuf}};
use thiserror::Error;

pub const API_VERSION: &str = "devtools.plugin/v2";
pub const DESCRIPTOR_FILE: &str = "plugin.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageDescriptor {
    pub api_version: String,
    pub manifest: String,
    #[serde(default)] pub processor: Option<String>,
    #[serde(default)] pub frontend: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DiscoveredPackage {
    pub root: PathBuf,
    pub manifest_path: PathBuf,
    pub processor_path: PathBuf,
    pub frontend_path: Option<PathBuf>,
    pub descriptor: PackageDescriptor,
    pub manifest: PluginManifest,
}

#[derive(Debug, Error)]
pub enum DiscoveryError {
    #[error("trusted plugin root does not exist: {0}")]
    MissingRoot(PathBuf),
    #[error("cannot read trusted plugin root {path}: {source}")]
    RootIo { path: PathBuf, source: std::io::Error },
    #[error("plugin `{path}` is missing {DESCRIPTOR_FILE}")]
    MissingDescriptor { path: PathBuf },
    #[error("invalid {DESCRIPTOR_FILE} for `{path}`: {message}")]
    MalformedDescriptor { path: PathBuf, message: String },
    #[error("plugin `{plugin}` uses unsupported API `{api}`; expected `{API_VERSION}`")]
    UnsupportedApi { plugin: String, api: String },
    #[error("plugin `{plugin}` has an invalid {field} entrypoint `{value}`: {reason}")]
    InvalidEntrypoint { plugin: String, field: &'static str, value: String, reason: String },
    #[error("plugin `{plugin}` {field} entrypoint `{path}` does not exist or is not a file")]
    MissingEntrypoint { plugin: String, field: &'static str, path: PathBuf },
    #[error("plugin `{plugin}` is missing its processor entrypoint")]
    MissingProcessor { plugin: String },
    #[error("plugin `{plugin}` has an invalid manifest: {message}")]
    InvalidManifest { plugin: String, message: String },
    #[error("duplicate plugin id `{id}` in `{first}` and `{second}`")]
    DuplicateId { id: String, first: PathBuf, second: PathBuf },
    #[error("failed to read `{path}`: {source}")]
    FileIo { path: PathBuf, source: std::io::Error },
    #[error("failed to compose generated catalog: {0}")]
    CompositionIo(#[from] std::io::Error),
}

fn entrypoint(root: &Path, plugin: &str, field: &'static str, value: &str) -> Result<PathBuf, DiscoveryError> {
    let candidate = Path::new(value);
    if value.trim().is_empty() { return Err(DiscoveryError::InvalidEntrypoint { plugin: plugin.into(), field, value: value.into(), reason: "path is empty".into() }); }
    if candidate.is_absolute() || candidate.components().any(|part| matches!(part, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
        return Err(DiscoveryError::InvalidEntrypoint { plugin: plugin.into(), field, value: value.into(), reason: "absolute paths and parent traversal are forbidden".into() });
    }
    let root = root.canonicalize().map_err(|source| DiscoveryError::FileIo { path: root.into(), source })?;
    let path = root.join(candidate);
    let canonical = path.canonicalize().map_err(|source| DiscoveryError::FileIo { path: path.clone(), source })?;
    if !canonical.starts_with(&root) { return Err(DiscoveryError::InvalidEntrypoint { plugin: plugin.into(), field, value: value.into(), reason: "resolved path escapes package root".into() }); }
    if !canonical.is_file() { return Err(DiscoveryError::MissingEntrypoint { plugin: plugin.into(), field, path: canonical }); }
    Ok(canonical)
}

fn discover_one(root: &Path, package_dir: &Path) -> Result<DiscoveredPackage, DiscoveryError> {
    let descriptor_path = package_dir.join(DESCRIPTOR_FILE);
    if !descriptor_path.is_file() { return Err(DiscoveryError::MissingDescriptor { path: package_dir.to_path_buf() }); }
    let plugin_hint = package_dir.file_name().and_then(|v| v.to_str()).unwrap_or("<unknown>").to_owned();
    let descriptor_value: serde_json::Value = serde_json::from_str(&fs::read_to_string(&descriptor_path).map_err(|source| DiscoveryError::FileIo { path: descriptor_path.clone(), source })?).map_err(|error| DiscoveryError::MalformedDescriptor { path: descriptor_path.clone(), message: error.to_string() })?;
    let descriptor: PackageDescriptor = serde_json::from_value(descriptor_value).map_err(|error| DiscoveryError::MalformedDescriptor { path: descriptor_path.clone(), message: error.to_string() })?;
    if descriptor.api_version != API_VERSION { return Err(DiscoveryError::UnsupportedApi { plugin: plugin_hint, api: descriptor.api_version }); }
    let processor = descriptor.processor.as_deref().ok_or_else(|| DiscoveryError::MissingProcessor { plugin: plugin_hint.clone() })?;
    if processor.trim().is_empty() { return Err(DiscoveryError::MissingProcessor { plugin: plugin_hint }); }
    let manifest_path = entrypoint(package_dir, &plugin_hint, "manifest", &descriptor.manifest).or_else(|error| Err(error))?;
    let processor_path = entrypoint(package_dir, &plugin_hint, "processor", processor)?;
    let frontend_path = descriptor.frontend.as_deref().map(|path| entrypoint(package_dir, &plugin_hint, "frontend", path)).transpose()?;
    let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(&manifest_path).map_err(|source| DiscoveryError::FileIo { path: manifest_path.clone(), source })?).map_err(|error| DiscoveryError::InvalidManifest { plugin: plugin_hint.clone(), message: error.to_string() })?;
    let manifest = parse_manifest(&value).map_err(|error| DiscoveryError::InvalidManifest { plugin: plugin_hint, message: error.to_string() })?;
    // A package's canonical manifest identity is authoritative; a folder may
    // have any name to make clean-checkout fixtures easy to stage.
    let _ = root;
    Ok(DiscoveredPackage { root: package_dir.to_path_buf(), manifest_path, processor_path, frontend_path, descriptor, manifest })
}

pub fn discover(root: impl AsRef<Path>) -> Result<Vec<DiscoveredPackage>, DiscoveryError> {
    let root = root.as_ref();
    if !root.exists() { return Err(DiscoveryError::MissingRoot(root.to_path_buf())); }
    let mut dirs = fs::read_dir(root).map_err(|source| DiscoveryError::RootIo { path: root.to_path_buf(), source })?.collect::<Result<Vec<_>, _>>().map_err(|source| DiscoveryError::RootIo { path: root.to_path_buf(), source })?;
    dirs.sort_by_key(|entry| entry.file_name());
    let mut result = Vec::new();
    for entry in dirs { if entry.file_type().map_err(|source| DiscoveryError::RootIo { path: root.to_path_buf(), source })?.is_dir() { result.push(discover_one(root, &entry.path())?); } }
    result.sort_by(|left, right| left.manifest.id.cmp(&right.manifest.id).then_with(|| left.root.cmp(&right.root)));
    for pair in result.windows(2) { if pair[0].manifest.id == pair[1].manifest.id { return Err(DiscoveryError::DuplicateId { id: pair[0].manifest.id.clone(), first: pair[0].root.clone(), second: pair[1].root.clone() }); } }
    Ok(result)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry { pub id: String, pub version: String, pub manifest: String, pub processor: String, pub frontend: Option<String>, pub operation_ids: Vec<String> }

pub fn catalog(packages: &[DiscoveredPackage], output_dir: &Path) -> Result<(), DiscoveryError> {
    fs::create_dir_all(output_dir.join("frontend"))?; fs::create_dir_all(output_dir.join("native"))?;
    let entries: Vec<CatalogEntry> = packages.iter().map(|item| { let package = item.root.file_name().and_then(|name| name.to_str()).unwrap_or_default(); CatalogEntry { id: item.manifest.id.clone(), version: item.manifest.version.clone(), manifest: format!("{package}/{}", item.descriptor.manifest), processor: format!("{package}/{}", item.descriptor.processor.as_deref().unwrap_or_default()), frontend: item.descriptor.frontend.as_ref().map(|path| format!("{package}/{path}")), operation_ids: item.manifest.operations.iter().map(|op| op.id.clone()).collect() } }).collect();
    let catalog_json = serde_json::to_string_pretty(&entries).expect("catalog entries serialize");
    fs::write(output_dir.join("catalog.json"), format!("{catalog_json}\n"))?;
    let mut frontend = String::from("// @generated by plugin-discovery. DO NOT EDIT.\n"); frontend.push_str("export const frontendRegistrations = [\n");
    for entry in entries.iter().filter(|entry| entry.frontend.is_some()) { frontend.push_str(&format!("  {{ id: {}, source: {} }},\n", serde_json::to_string(&entry.id).unwrap(), serde_json::to_string(entry.frontend.as_deref().unwrap()).unwrap())); }
    frontend.push_str("];\n"); fs::write(output_dir.join("frontend/registrations.ts"), frontend)?;
    let imports = entries.iter().map(|entry| serde_json::json!({"id":entry.id,"processor":entry.processor})).collect::<Vec<_>>(); fs::write(output_dir.join("native/import-map.json"), format!("{}\n", serde_json::to_string_pretty(&imports).unwrap()))?;
    let mut native = String::from("// @generated by plugin-discovery. DO NOT EDIT.\n#[derive(Debug, Clone, Copy)]\npub struct ExecutorDescriptor { pub plugin_id: &'static str, pub processor: &'static str }\n\npub static EXECUTORS: &[ExecutorDescriptor] = &[\n");
    for entry in &entries { native.push_str(&format!("  ExecutorDescriptor {{ plugin_id: {}, processor: {} }},\n", rust_string(&entry.id), rust_string(&entry.processor))); }
    native.push_str("];\n"); fs::write(output_dir.join("native/executors.rs"), native)?;
    Ok(())
}

fn rust_string(value: &str) -> String { format!("{:?}", value) }

#[cfg(test)]
mod tests {
    use super::*; use std::sync::atomic::{AtomicUsize, Ordering}; use std::time::{SystemTime, UNIX_EPOCH};
    fn temp() -> PathBuf {
        // Tests run on parallel threads, so a timestamp alone can collide and one test
        // then sees another test's packages. Combine the process id and a counter.
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("devtools-plugin-discovery-{}-{}-{nanos}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)))
    }
    fn write_pkg(root: &Path, dir: &str, id: &str) { let pkg = root.join(dir); fs::create_dir_all(&pkg).unwrap(); fs::write(pkg.join("plugin.json"), r#"{"apiVersion":"devtools.plugin/v2","manifest":"manifest.json","processor":"processor.mjs"}"#).unwrap(); fs::write(pkg.join("processor.mjs"), "export async function execute() {}\n").unwrap(); let manifest = serde_json::json!({"kind":"pluginManifest","apiVersion":"devtools.plugin/v2","id":id,"version":"0.1.0","stateVersion":1,"tools":[{"id":format!("{id}.tool"),"title":"Example","category":"example","operationIds":["run"],"workspaceId":"workspace"}],"operations":[{"id":"run","title":"Run","executor":{"kind":"javascriptWorker","id":"processor","version":"0.1","cancellation":"cooperative"},"inputs":[],"outputs":[{"id":"output","kind":"artifact","multiplicity":"one","representations":["text"],"sensitive":false,"exports":["copyText"]}],"options":[],"trigger":{"modes":["explicit"],"debounceMs":"0"},"limits":{"maxInputBytes":"100","maxOutputBytes":"100","maxChunkBytes":"100","deadlineMs":"0"}}],"workspaces":[{"id":"workspace","kind":"generator","bindings":[],"commands":[],"presentationSettings":[]}],"capabilities":[],"settings":[],"tests":{"requirementIds":[],"fixtures":[],"uiScenarios":[]}}); fs::write(pkg.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap(); }
    #[test] fn deterministic_discovery_and_duplicate_detection() { let root = temp(); write_pkg(&root,"z","z.example"); write_pkg(&root,"a","a.example"); let found = discover(&root).unwrap(); assert_eq!(found.iter().map(|p| p.manifest.id.as_str()).collect::<Vec<_>>(), vec!["a.example","z.example"]); write_pkg(&root,"dup","a.example"); assert!(matches!(discover(&root), Err(DiscoveryError::DuplicateId { .. }))); let _ = fs::remove_dir_all(root); }
    #[test] fn rejects_traversal_and_missing_processor() { let root = temp(); let pkg = root.join("bad"); fs::create_dir_all(&pkg).unwrap(); fs::write(pkg.join("plugin.json"), r#"{"apiVersion":"devtools.plugin/v2","manifest":"../manifest.json","processor":"processor.mjs"}"#).unwrap(); assert!(matches!(discover(&root), Err(DiscoveryError::InvalidEntrypoint { field: "manifest", .. }))); let _ = fs::remove_dir_all(root); }
    #[test] fn diagnostics_cover_descriptor_api_processor_and_composition() {
        let root = temp(); let bad = root.join("bad"); fs::create_dir_all(&bad).unwrap();
        fs::write(bad.join("plugin.json"), r#"{"apiVersion":"devtools.plugin/v9","manifest":"manifest.json","processor":"processor.mjs"}"#).unwrap(); assert!(matches!(discover(&root), Err(DiscoveryError::UnsupportedApi { .. })));
        fs::write(bad.join("plugin.json"), r#"{"apiVersion":"devtools.plugin/v2","manifest":"manifest.json"}"#).unwrap(); assert!(matches!(discover(&root), Err(DiscoveryError::MissingProcessor { .. }))); fs::remove_dir_all(&bad).unwrap();
        write_pkg(&root, "good", "good.example"); let packages = discover(&root).unwrap(); let out = root.join("generated"); catalog(&packages, &out).unwrap();
        let json = fs::read_to_string(out.join("catalog.json")).unwrap(); assert!(json.contains("good.example")); assert!(out.join("frontend/registrations.ts").is_file()); assert!(out.join("native/import-map.json").is_file()); let _ = fs::remove_dir_all(root);
    }
}
