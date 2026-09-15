//! Host-owned plugin dispatch.
//!
//! The workbench must not decide how a tool is executed.  This module is the
//! small native seam between the job scheduler and an executor implementation.
//! Existing tools are registered through the legacy adapter below; a future
//! v2 executor can implement the same registry without adding another
//! `tool_id` branch to the scheduler.

use devtools_core::{CancellationToken, Document, Progress, ToolError, ToolManifest, ToolResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

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
    executors: HashMap<String, LegacyExecutor>,
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
        self.executors.insert(manifest.id.clone(), executor);
        self.manifests.insert(manifest.id.clone(), manifest);
        Ok(())
    }

    pub fn manifest(&self, tool_id: &str) -> Result<ToolManifest, ToolError> {
        self.manifests.get(tool_id).cloned().ok_or_else(|| ToolError::UnknownTool { tool_id: tool_id.into() })
    }

    pub fn executor(&self, tool_id: &str) -> Result<LegacyExecutor, ToolError> {
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
        let executor = self.executor(tool_id)?;
        executor(tool_id, operation_id, input, options, cancellation, progress)
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

    #[test]
    fn registry_dispatches_without_scheduler_tool_branching() {
        let host = PluginHost::with_legacy([manifest("example.echo")], executor);
        let result = host.dispatch("example.echo", "run", &Document::from_text("ok"), &Value::Object(Default::default()), &CancellationToken::default(), &|_| {}).unwrap();
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
}
