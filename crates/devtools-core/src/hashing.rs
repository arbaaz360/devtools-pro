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
}

impl HashResult {
    /// The result document is the lowercase hex digest and nothing else, so it can be
    /// copied or saved as-is. Where the bytes came from (often a host temp snapshot of
    /// pasted text) is deliberately not part of the result.
    pub fn to_tool_result(&self) -> ToolResult { ToolResult { output: Document::from_text(&self.digest).with_kind(DocumentKind::Text).with_mime("text/plain"), diagnostics: Vec::new() } }
    /// One line for the job summary, e.g. "SHA-256 · 3 bytes".
    pub fn summary(&self) -> String { format!("{} · {} {}", self.algorithm, self.byte_count, if self.byte_count == 1 { "byte" } else { "bytes" }) }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HashStats { pub bytes_read: u64 }

fn hash_bytes<R: Read>(mut reader: R, algorithm: HashAlgorithm, cancel: &CancellationToken, progress: impl Fn(Progress), total: Option<u64>) -> Result<(HashResult, HashStats), ToolError> {
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
    Ok((HashResult { algorithm: algorithm.as_str().into(), digest, byte_count: read }, HashStats { bytes_read: read }))
}

pub fn hash_reader<R: Read>(reader: R, algorithm: HashAlgorithm, total_bytes: Option<u64>, cancel: &CancellationToken, progress: impl Fn(Progress)) -> Result<(HashResult, HashStats), ToolError> {
    hash_bytes(reader, algorithm, cancel, progress, total_bytes)
}

pub fn hash_file(path: &Path, algorithm: HashAlgorithm, cancel: &CancellationToken, progress: impl Fn(Progress)) -> Result<(HashResult, HashStats), ToolError> {
    let file = std::fs::File::open(path)?;
    let total = file.metadata()?.len();
    hash_bytes(file, algorithm, cancel, progress, Some(total))
}

pub fn hash_document(input: &Document, algorithm: HashAlgorithm, cancel: &CancellationToken, progress: impl Fn(Progress)) -> Result<(HashResult, HashStats), ToolError> {
    hash_bytes(input.bytes(), algorithm, cancel, progress, Some(input.len() as u64))
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
        Ok(result.to_tool_result())
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
    fn tool_output_is_the_digest_alone_as_plain_text() {
        let result = HashTool::default().execute("sha256", &Document::from_bytes(b"abc".to_vec()).with_kind(DocumentKind::Binary), &serde_json::json!({})).unwrap();
        assert_eq!(result.output.as_text().unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(result.output.mime.as_deref(), Some("text/plain"));
        assert_eq!(result.output.kind, DocumentKind::Text);
    }

    #[test]
    fn summary_names_the_algorithm_and_the_byte_count() {
        let token = CancellationToken::default();
        let (three, _) = hash_reader(Cursor::new(b"abc"), HashAlgorithm::Sha256, Some(3), &token, |_| {}).unwrap();
        assert_eq!(three.summary(), "SHA-256 · 3 bytes");
        let (one, _) = hash_reader(Cursor::new(b"a"), HashAlgorithm::Sha512, Some(1), &token, |_| {}).unwrap();
        assert_eq!(one.summary(), "SHA-512 · 1 byte");
    }

    #[test]
    fn file_hash_keeps_no_trace_of_the_path() {
        let path = std::env::temp_dir().join(format!("devtools-hash-path-{}.txt", std::process::id()));
        std::fs::write(&path, b"abc").unwrap();
        let (result, _) = hash_file(&path, HashAlgorithm::Sha256, &CancellationToken::default(), |_| {}).unwrap();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let output = result.to_tool_result().output;
        for text in [output.as_text().unwrap().to_string(), result.summary(), serde_json::to_string(&result).unwrap()] { assert!(!text.contains(&name), "{text} leaks {name}"); }
        assert_eq!(output.as_text().unwrap(), result.digest);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cancellation_is_observable() {
        let token = CancellationToken::default(); token.cancel();
        assert!(matches!(hash_reader(Cursor::new(vec![1u8; 10]), HashAlgorithm::Sha256, Some(10), &token, |_| {}), Err(ToolError::Cancelled)));
    }
}
