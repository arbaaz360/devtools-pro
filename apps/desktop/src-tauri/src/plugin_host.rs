//! Host-owned plugin dispatch.
//!
//! The workbench must not decide how a tool is executed.  This module is the
//! small native seam between the job scheduler and an executor implementation.
//! Existing tools are registered through the legacy adapter below; native
//! processors receive host-owned named ports without adding another `tool_id`
//! branch to the scheduler.

use devtools_core::{CancellationToken, Document, Progress, ToolError, ToolManifest, ToolResult};
use devtools_plugin_contract::{ArtifactRef, EventIdentity};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use thiserror::Error;

/// The temporary compatibility signature used by the current in-process
/// tools.  It deliberately receives a document value and named operation,
/// rather than a filesystem path or a destination chosen by the webview.
pub type LegacyExecutor = fn(
    tool_id: &str,
    operation_id: &str,
    input: &Document,
    options: &Value,
    cancellation: &CancellationToken,
    progress: &dyn Fn(Progress),
) -> Result<ToolResult, ToolError>;

/// Native plugin entry point. The host supplies named inputs and a bounded
/// artifact sink; the processor cannot access filesystem paths or publish a
/// destination of its choosing.
pub type NativeExecutor = for<'a> fn(&mut NativeExecutionContext<'a>) -> Result<(), ToolError>;

#[derive(Clone, Copy)]
pub enum RegisteredExecutor {
    Legacy(LegacyExecutor),
    Native(NativeExecutor),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionIdentity {
    pub plugin_id: String,
    pub plugin_version: String,
    pub tool_id: String,
    pub operation_id: String,
    pub instance_id: String,
    pub job_id: String,
    pub generation: u64,
}

impl ExecutionIdentity {
    pub fn new(tool_id: impl Into<String>, operation_id: impl Into<String>, job_id: impl Into<String>) -> Self {
        Self {
            plugin_id: "legacy.builtin".into(),
            plugin_version: "0.1.0".into(),
            tool_id: tool_id.into(),
            operation_id: operation_id.into(),
            instance_id: "legacy".into(),
            job_id: job_id.into(),
            generation: 0,
        }
    }

    pub fn event_identity(&self, sequence: u64) -> EventIdentity {
        EventIdentity {
            api_version: "devtools.plugin/v2".into(),
            plugin_id: self.plugin_id.clone(),
            plugin_version: self.plugin_version.clone(),
            tool_id: self.tool_id.clone(),
            operation_id: self.operation_id.clone(),
            instance_id: self.instance_id.clone(),
            job_id: self.job_id.clone(),
            generation: self.generation.to_string(),
            sequence: sequence.to_string(),
        }
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ServiceError {
    #[error("document `{0}` is not available")]
    MissingDocument(String),
    #[error("requested range exceeds the host read limit")]
    ReadLimit,
    #[error("artifact output exceeds the host limit")]
    OutputLimit,
}

/// Host-owned services exposed to a native processor for one operation.
pub struct NativeExecutionContext<'a> {
    operation_id: &'a str,
    options: &'a Value,
    cancellation: &'a CancellationToken,
    progress: &'a dyn Fn(Progress),
    reader: MemoryDocumentReader,
    sink: MemoryArtifactSink,
    input_limit: u64,
}

impl<'a> NativeExecutionContext<'a> {
    pub fn new(
        operation_id: &'a str,
        options: &'a Value,
        cancellation: &'a CancellationToken,
        progress: &'a dyn Fn(Progress),
        input_limit: u64,
        output_limit: Option<u64>,
    ) -> Self {
        Self { operation_id, options, cancellation, progress, reader: MemoryDocumentReader::default(), sink: MemoryArtifactSink::with_limit(output_limit), input_limit }
    }

    pub fn add_input(&mut self, port_id: impl Into<String>, bytes: Vec<u8>) { self.reader.insert(port_id, bytes); }
    pub fn operation_id(&self) -> &str { self.operation_id }
    pub fn options(&self) -> &Value { self.options }
    pub fn cancellation(&self) -> &CancellationToken { self.cancellation }
    pub fn progress(&self, progress: Progress) { (self.progress)(progress); }
    pub fn read_input(&self, port_id: &str) -> Result<Vec<u8>, ServiceError> { self.reader.read_range(port_id, 0, self.input_limit) }
    pub fn write_output(&mut self, port_id: &str, bytes: &[u8], mime: Option<&str>) -> Result<ArtifactRef, ServiceError> { self.sink.write(port_id, bytes, mime) }
    pub fn take_outputs(self) -> Vec<PublishedArtifact> { self.sink.artifacts }
}

/// Host-owned bounded reader. A v2 processor receives this service instead of
/// a path, so it cannot bypass source immutability or read outside its grant.
pub trait DocumentReader {
    fn read_range(&self, document_id: &str, offset: u64, max_bytes: u64) -> Result<Vec<u8>, ServiceError>;
}

/// A result sink supports more than one named output port and publishes only
/// complete artifacts. The host can replace this in-memory implementation
/// with a temporary-file sink without changing processor code.
pub trait ArtifactSink {
    fn write(&mut self, port_id: &str, bytes: &[u8], mime: Option<&str>) -> Result<ArtifactRef, ServiceError>;
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct PublishedArtifact {
    pub port_id: String,
    pub descriptor: ArtifactRef,
    pub bytes: Vec<u8>,
    pub mime: Option<String>,
}

#[derive(Debug, Default)]
pub struct MemoryArtifactSink {
    max_output_bytes: Option<u64>,
    total_bytes: u64,
    next_handle: u64,
    pub artifacts: Vec<PublishedArtifact>,
}

impl MemoryArtifactSink {
    pub fn with_limit(max_output_bytes: Option<u64>) -> Self { Self { max_output_bytes, ..Self::default() } }
}

impl ArtifactSink for MemoryArtifactSink {
    fn write(&mut self, port_id: &str, bytes: &[u8], mime: Option<&str>) -> Result<ArtifactRef, ServiceError> {
        let next_total = self.total_bytes.saturating_add(bytes.len() as u64);
        if self.max_output_bytes.is_some_and(|limit| next_total > limit) { return Err(ServiceError::OutputLimit); }
        let digest = Sha256::digest(bytes);
        let descriptor = ArtifactRef { handle: format!("memory:artifact-{}", self.next_handle), byte_length: bytes.len().to_string(), content_hash: format!("{digest:x}") };
        self.next_handle += 1;
        self.total_bytes = next_total;
        self.artifacts.push(PublishedArtifact { port_id: port_id.into(), descriptor: descriptor.clone(), bytes: bytes.to_vec(), mime: mime.map(str::to_owned) });
        Ok(descriptor)
    }
}

#[derive(Debug, Default)]
pub struct MemoryDocumentReader {
    documents: HashMap<String, Vec<u8>>,
}

impl MemoryDocumentReader {
    pub fn insert(&mut self, id: impl Into<String>, bytes: Vec<u8>) { self.documents.insert(id.into(), bytes); }
}

impl DocumentReader for MemoryDocumentReader {
    fn read_range(&self, document_id: &str, offset: u64, max_bytes: u64) -> Result<Vec<u8>, ServiceError> {
        let bytes = self.documents.get(document_id).ok_or_else(|| ServiceError::MissingDocument(document_id.into()))?;
        let start = usize::try_from(offset).map_err(|_| ServiceError::ReadLimit)?;
        let end = start.saturating_add(usize::try_from(max_bytes).map_err(|_| ServiceError::ReadLimit)?).min(bytes.len());
        if start > bytes.len() { return Ok(Vec::new()); }
        Ok(bytes[start..end].to_vec())
    }
}

/// Prevents a job from publishing two terminal outcomes when cancellation,
/// an error and a worker completion race one another.
#[derive(Debug, Default)]
pub struct TerminalEventGuard(std::sync::atomic::AtomicBool);

impl TerminalEventGuard {
    pub fn claim(&self) -> bool {
        !self.0.swap(true, std::sync::atomic::Ordering::AcqRel)
    }

    pub fn is_claimed(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Acquire)
    }
}

#[derive(Default)]
pub struct PluginHost {
    manifests: HashMap<String, ToolManifest>,
    executors: HashMap<String, RegisteredExecutor>,
}

impl PluginHost {
    pub fn with_legacy(manifests: impl IntoIterator<Item = ToolManifest>, executor: LegacyExecutor) -> Self {
        let mut host = Self::default();
        for manifest in manifests {
            host.register_legacy(manifest, executor).expect("built-in manifests must be unique");
        }
        host
    }

    pub fn register_legacy(&mut self, manifest: ToolManifest, executor: LegacyExecutor) -> Result<(), ToolError> {
        if self.manifests.contains_key(&manifest.id) {
            return Err(ToolError::Execution { message: format!("duplicate registered tool id `{}`", manifest.id) });
        }
        self.executors.insert(manifest.id.clone(), RegisteredExecutor::Legacy(executor));
        self.manifests.insert(manifest.id.clone(), manifest);
        Ok(())
    }

    pub fn register_native(&mut self, manifest: ToolManifest, executor: NativeExecutor) -> Result<(), ToolError> {
        if self.manifests.contains_key(&manifest.id) {
            return Err(ToolError::Execution { message: format!("duplicate registered tool id `{}`", manifest.id) });
        }
        self.executors.insert(manifest.id.clone(), RegisteredExecutor::Native(executor));
        self.manifests.insert(manifest.id.clone(), manifest);
        Ok(())
    }

    pub fn replace_native(&mut self, tool_id: &str, executor: NativeExecutor) -> Result<(), ToolError> {
        if !self.manifests.contains_key(tool_id) {
            return Err(ToolError::UnknownTool { tool_id: tool_id.into() });
        }
        self.executors.insert(tool_id.into(), RegisteredExecutor::Native(executor));
        Ok(())
    }

    pub fn manifest(&self, tool_id: &str) -> Result<ToolManifest, ToolError> {
        self.manifests.get(tool_id).cloned().ok_or_else(|| ToolError::UnknownTool { tool_id: tool_id.into() })
    }

    pub fn executor(&self, tool_id: &str) -> Result<RegisteredExecutor, ToolError> {
        self.executors.get(tool_id).copied().ok_or_else(|| ToolError::UnknownTool { tool_id: tool_id.into() })
    }

    pub fn dispatch(
        &self,
        tool_id: &str,
        operation_id: &str,
        input: &Document,
        options: &Value,
        cancellation: &CancellationToken,
        progress: &dyn Fn(Progress),
    ) -> Result<ToolResult, ToolError> {
        match self.executor(tool_id)? {
            RegisteredExecutor::Legacy(executor) => executor(tool_id, operation_id, input, options, cancellation, progress),
            RegisteredExecutor::Native(executor) => {
                let mut context = NativeExecutionContext::new(operation_id, options, cancellation, progress, input.len() as u64, None);
                context.add_input("source", input.bytes().to_vec());
                executor(&mut context)?;
                let artifact = context.take_outputs().into_iter().next().ok_or_else(|| ToolError::Execution { message: "native plugin produced no output".into() })?;
                Ok(ToolResult { output: Document::from_bytes(artifact.bytes).with_mime(artifact.mime.unwrap_or_else(|| "application/octet-stream".into())), diagnostics: Vec::new() })
            }
        }
    }

    pub fn manifests(&self) -> Vec<ToolManifest> {
        let mut manifests = self.manifests.values().cloned().collect::<Vec<_>>();
        manifests.sort_by(|left, right| left.id.cmp(&right.id));
        manifests
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use devtools_core::{DocumentKind, ToolCapabilities, ToolLimits, ToolOperation, RendererKind, InputKind};

    fn manifest(id: &str) -> ToolManifest {
        ToolManifest {
            id: id.into(), label: id.into(), contract_version: 1,
            input_kinds: vec![InputKind::Text],
            limits: ToolLimits { max_input_bytes: None, max_output_bytes: None },
            capabilities: ToolCapabilities { deterministic: true, supports_preview: true, supports_streaming: false, cancellation: true, progress: false, needs_filesystem: false, needs_network: false, needs_secrets: false },
            operations: vec![ToolOperation { id: "run".into(), label: "Run".into(), default_options: Value::Object(Default::default()) }],
            renderer: RendererKind::Text,
        }
    }

    fn executor(_: &str, _: &str, input: &Document, _: &Value, _: &CancellationToken, _: &dyn Fn(Progress)) -> Result<ToolResult, ToolError> {
        Ok(ToolResult { output: input.clone().with_kind(DocumentKind::Text), diagnostics: vec![] })
    }

    fn native_executor(context: &mut NativeExecutionContext<'_>) -> Result<(), ToolError> {
        let input = context.read_input("source").map_err(|error| ToolError::Execution { message: error.to_string() })?;
        context.write_output("result", &input, Some("text/plain")).map_err(|error| ToolError::Execution { message: error.to_string() })?;
        Ok(())
    }

    #[test]
    fn registry_dispatches_without_scheduler_tool_branching() {
        let host = PluginHost::with_legacy([manifest("example.echo")], executor);
        let result = host.dispatch("example.echo", "run", &Document::from_text("ok"), &Value::Object(Default::default()), &CancellationToken::default(), &|_| {}).unwrap();
        assert_eq!(result.output.as_text().unwrap(), "ok");
    }

    #[test]
    fn native_executor_uses_the_same_registry_dispatch() {
        let mut host = PluginHost::default();
        host.register_native(manifest("example.native"), native_executor).unwrap();
        let result = host.dispatch("example.native", "run", &Document::from_text("ok"), &Value::Object(Default::default()), &CancellationToken::default(), &|_| {}).unwrap();
        assert_eq!(result.output.as_text().unwrap(), "ok");
    }

    #[test]
    fn duplicate_ids_are_rejected_and_manifests_are_sorted() {
        let mut host = PluginHost::default();
        host.register_legacy(manifest("z.tool"), executor).unwrap();
        assert!(host.register_legacy(manifest("z.tool"), executor).is_err());
        host.register_legacy(manifest("a.tool"), executor).unwrap();
        assert_eq!(host.manifests().iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["a.tool", "z.tool"]);
    }

    #[test]
    fn terminal_guard_allows_exactly_one_claim() {
        let guard = TerminalEventGuard::default();
        assert!(guard.claim());
        assert!(!guard.claim());
        assert!(guard.is_claimed());
    }

    #[test]
    fn bounded_reader_and_multi_port_sink_keep_host_limits() {
        let mut reader = MemoryDocumentReader::default();
        reader.insert("doc", b"abcdef".to_vec());
        assert_eq!(reader.read_range("doc", 1, 3).unwrap(), b"bcd");
        assert!(matches!(reader.read_range("missing", 0, 1), Err(ServiceError::MissingDocument(_))));

        let mut sink = MemoryArtifactSink::with_limit(Some(5));
        let first = sink.write("text", b"abc", Some("text/plain")).unwrap();
        let second = sink.write("metadata", b"de", None).unwrap();
        assert_eq!(sink.artifacts.len(), 2);
        assert_eq!(first.byte_length, "3");
        assert_eq!(second.byte_length, "2");
        assert!(matches!(sink.write("overflow", b"f", None), Err(ServiceError::OutputLimit)));
    }

    #[test]
    fn execution_identity_maps_to_canonical_event_identity() {
        let identity = ExecutionIdentity::new("example.tool", "run", "job-1");
        let event = identity.event_identity(4);
        assert_eq!(event.api_version, "devtools.plugin/v2");
        assert_eq!(event.tool_id, "example.tool");
        assert_eq!(event.sequence, "4");
    }
}
