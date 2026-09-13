use crate::{CancellationToken, Document, DocumentKind, GenericTool, InputKind, Progress, RendererKind, ToolCapabilities, ToolError, ToolLimits, ToolManifest, ToolOperation, ToolResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256, Sha512};
use std::io::Read;
use std::path::Path;

const CHUNK_SIZE: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HashAlgorithm { Sha256, Sha512 }

impl HashAlgorithm {
    pub fn as_str(self) -> &'static str { match self { Self::Sha256 => "SHA-256", Self::Sha512 => "SHA-512" } }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashResult {
    pub algorithm: String,
    pub digest: String,
    pub byte_count: u64,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HashStats { pub bytes_read: u64 }

fn hash_bytes<R: Read>(mut reader: R, algorithm: HashAlgorithm, source: Option<String>, cancel: &CancellationToken, progress: impl Fn(Progress), total: Option<u64>) -> Result<(HashResult, HashStats), ToolError> {
    let mut sha256 = Sha256::new();
    let mut sha512 = Sha512::new();
    let mut buffer = [0u8; CHUNK_SIZE];
    let mut read = 0u64;
    progress(Progress { bytes_processed: 0, total_bytes: total.unwrap_or(0), phase: "hashing".into() });
    loop {
        if cancel.is_cancelled() { return Err(ToolError::Cancelled); }
        let n = reader.read(&mut buffer)?;
        if n == 0 { break; }
        match algorithm { HashAlgorithm::Sha256 => sha256.update(&buffer[..n]), HashAlgorithm::Sha512 => sha512.update(&buffer[..n]) }
        read += n as u64;
        progress(Progress { bytes_processed: read, total_bytes: total.unwrap_or(0), phase: "hashing".into() });
    }
    let digest = match algorithm {
        HashAlgorithm::Sha256 => format!("{:x}", sha256.finalize()),
        HashAlgorithm::Sha512 => format!("{:x}", sha512.finalize()),
    };
    Ok((HashResult { algorithm: algorithm.as_str().into(), digest, byte_count: read, source }, HashStats { bytes_read: read }))
}

pub fn hash_reader<R: Read>(reader: R, algorithm: HashAlgorithm, total_bytes: Option<u64>, cancel: &CancellationToken, progress: impl Fn(Progress)) -> Result<(HashResult, HashStats), ToolError> {
    hash_bytes(reader, algorithm, None, cancel, progress, total_bytes)
}

pub fn hash_file(path: &Path, algorithm: HashAlgorithm, cancel: &CancellationToken, progress: impl Fn(Progress)) -> Result<(HashResult, HashStats), ToolError> {
    let file = std::fs::File::open(path)?;
    let total = file.metadata()?.len();
    hash_bytes(file, algorithm, Some(path.to_string_lossy().into_owned()), cancel, progress, Some(total))
}

pub fn hash_document(input: &Document, algorithm: HashAlgorithm, cancel: &CancellationToken, progress: impl Fn(Progress)) -> Result<(HashResult, HashStats), ToolError> {
    hash_bytes(input.bytes(), algorithm, None, cancel, progress, Some(input.len() as u64))
}

pub struct HashTool { manifest: ToolManifest }

impl Default for HashTool {
    fn default() -> Self {
        Self { manifest: ToolManifest {
            id: "encoding.hash".into(), label: "Hash Generator".into(), contract_version: 1,
            input_kinds: vec![InputKind::Bytes], limits: ToolLimits { max_input_bytes: None, max_output_bytes: Some(4096) },
            capabilities: ToolCapabilities { deterministic: true, supports_preview: true, supports_streaming: true, cancellation: true, progress: true, needs_filesystem: true, needs_network: false, needs_secrets: false },
            operations: vec![ToolOperation { id: "sha256".into(), label: "SHA-256".into(), default_options: Value::Object(Default::default()) }, ToolOperation { id: "sha512".into(), label: "SHA-512".into(), default_options: Value::Object(Default::default()) }], renderer: RendererKind::Text,
        }}
    }
}

impl GenericTool for HashTool {
    fn manifest(&self) -> &ToolManifest { &self.manifest }
    fn execute(&self, operation_id: &str, input: &Document, _options: &Value) -> Result<ToolResult, ToolError> {
        let algorithm = match operation_id { "sha256" => HashAlgorithm::Sha256, "sha512" => HashAlgorithm::Sha512, _ => return Err(ToolError::UnsupportedOperation { tool_id: self.manifest.id.clone(), operation_id: operation_id.into() }) };
        let (result, _) = hash_document(input, algorithm, &CancellationToken::default(), |_| {})?;
        let text = serde_json::to_string_pretty(&result).map_err(|e| ToolError::Execution { message: e.to_string() })?;
        Ok(ToolResult { output: Document::from_text(text).with_kind(DocumentKind::Text).with_mime("application/json"), diagnostics: Vec::new() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn known_vectors() {
        let token = CancellationToken::default();
        let (a, _) = hash_reader(Cursor::new(b"abc"), HashAlgorithm::Sha256, Some(3), &token, |_| {}).unwrap();
        assert_eq!(a.digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let (b, _) = hash_reader(Cursor::new(b"abc"), HashAlgorithm::Sha512, Some(3), &token, |_| {}).unwrap();
        assert_eq!(b.digest, "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f");
    }

    #[test]
    fn large_fixture_reports_progress_and_count() {
        let data = vec![0x5au8; CHUNK_SIZE * 4 + 7];
        let seen = std::cell::RefCell::new(Vec::new());
        let (result, stats) = hash_reader(Cursor::new(data.clone()), HashAlgorithm::Sha256, Some(data.len() as u64), &CancellationToken::default(), |p| seen.borrow_mut().push(p.bytes_processed)).unwrap();
        assert_eq!(result.byte_count, data.len() as u64);
        assert_eq!(stats.bytes_read, data.len() as u64);
        assert!(seen.borrow().last() == Some(&(data.len() as u64)));
        assert!(seen.borrow().len() >= 2);
    }

    #[test]
    fn cancellation_is_observable() {
        let token = CancellationToken::default(); token.cancel();
        assert!(matches!(hash_reader(Cursor::new(vec![1u8; 10]), HashAlgorithm::Sha256, Some(10), &token, |_| {}), Err(ToolError::Cancelled)));
    }
}
