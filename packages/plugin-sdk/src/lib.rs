//! UI and host independent primitives for bundled plugin processors.
//!
//! The SDK deliberately exposes only named ports and bounded services.  A
//! processor can be tested with the in-memory implementations in this crate
//! without Tauri, a browser, or global clock/randomness objects.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SdkError {
    #[error("named input `{0}` was not supplied")]
    MissingInput(String),
    #[error("named output `{0}` was not declared")]
    MissingOutput(String),
    #[error("read of `{name}` exceeds the {limit} byte limit")]
    InputLimit { name: String, limit: usize },
    #[error("output exceeds the {limit} byte limit")]
    OutputLimit { limit: usize },
    #[error("processor cancelled")]
    Cancelled,
    #[error("secret handle `{0}` is unavailable")]
    MissingSecret(String),
    #[error("invalid request: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_input_bytes: usize,
    pub max_output_bytes: usize,
    pub max_chunk_bytes: usize,
    pub deadline_ms: u64,
}

impl Default for Limits {
    fn default() -> Self { Self { max_input_bytes: 16 * 1024 * 1024, max_output_bytes: 16 * 1024 * 1024, max_chunk_bytes: 1024 * 1024, deadline_ms: 0 } }
}

pub trait NamedReader {
    fn read(&mut self, port: &str, max_bytes: usize) -> Result<Vec<u8>, SdkError>;
}

pub trait OutputSink {
    fn write(&mut self, port: &str, bytes: &[u8], limits: Limits) -> Result<Artifact, SdkError>;
    fn value(&mut self, port: &str, value: Value) -> Result<(), SdkError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artifact { pub handle: String, pub byte_length: usize, pub content_hash: String }

pub trait Cancellation: Send + Sync {
    fn is_cancelled(&self) -> bool;
    fn check(&self) -> Result<(), SdkError> { if self.is_cancelled() { Err(SdkError::Cancelled) } else { Ok(()) } }
}

#[derive(Clone, Default)]
pub struct AtomicCancellation(Arc<AtomicBool>);
impl AtomicCancellation { pub fn cancel(&self) { self.0.store(true, Ordering::SeqCst); } }
impl Cancellation for AtomicCancellation { fn is_cancelled(&self) -> bool { self.0.load(Ordering::SeqCst) } }

pub trait Clock: Send + Sync { fn now_rfc3339(&self) -> &str; }
pub trait Randomness: Send + Sync { fn fill(&mut self, bytes: &mut [u8]); fn id(&self) -> &str; }
pub trait SecretStore: Send + Sync { fn resolve(&self, handle: &str) -> Result<Vec<u8>, SdkError>; }

/// Services available to one processor invocation.  No service is global;
/// callers inject all implementations, including deterministic test doubles.
pub struct ProcessorContext<'a, R: NamedReader, O: OutputSink, C: Cancellation, K: Clock, N: Randomness, S: SecretStore> {
    pub reader: &'a mut R,
    pub outputs: &'a mut O,
    pub cancellation: &'a C,
    pub clock: &'a K,
    pub randomness: &'a mut N,
    pub secrets: &'a S,
    pub limits: Limits,
}

impl<'a, R: NamedReader, O: OutputSink, C: Cancellation, K: Clock, N: Randomness, S: SecretStore> ProcessorContext<'a, R, O, C, K, N, S> {
    pub fn read(&mut self, port: &str) -> Result<Vec<u8>, SdkError> { self.cancellation.check()?; self.reader.read(port, self.limits.max_input_bytes) }
    pub fn write(&mut self, port: &str, bytes: &[u8]) -> Result<Artifact, SdkError> { self.cancellation.check()?; self.outputs.write(port, bytes, self.limits) }
    pub fn write_value(&mut self, port: &str, value: Value) -> Result<(), SdkError> { self.cancellation.check()?; self.outputs.value(port, value) }
    pub fn secret(&self, handle: &str) -> Result<Vec<u8>, SdkError> { self.cancellation.check()?; self.secrets.resolve(handle) }
}

#[derive(Default, Clone)]
pub struct MemoryReader { pub inputs: BTreeMap<String, Vec<u8>> }
impl MemoryReader { pub fn insert(&mut self, port: impl Into<String>, value: impl Into<Vec<u8>>) { self.inputs.insert(port.into(), value.into()); } }
impl NamedReader for MemoryReader {
    fn read(&mut self, port: &str, max_bytes: usize) -> Result<Vec<u8>, SdkError> {
        let value = self.inputs.get(port).ok_or_else(|| SdkError::MissingInput(port.into()))?;
        if value.len() > max_bytes { return Err(SdkError::InputLimit { name: port.into(), limit: max_bytes }); }
        Ok(value.clone())
    }
}

#[derive(Default, Clone)]
pub struct MemoryOutputSink { pub artifacts: BTreeMap<String, Artifact>, pub values: BTreeMap<String, Value>, pub bytes: BTreeMap<String, Vec<u8>> }
impl OutputSink for MemoryOutputSink {
    fn write(&mut self, port: &str, bytes: &[u8], limits: Limits) -> Result<Artifact, SdkError> {
        if bytes.len() > limits.max_chunk_bytes { return Err(SdkError::OutputLimit { limit: limits.max_chunk_bytes }); }
        if bytes.len() > limits.max_output_bytes { return Err(SdkError::OutputLimit { limit: limits.max_output_bytes }); }
        let mut hash = Sha256::new(); hash.update(bytes); let content_hash = format!("{:x}", hash.finalize());
        let artifact = Artifact { handle: format!("memory:{port}"), byte_length: bytes.len(), content_hash };
        self.bytes.insert(port.into(), bytes.to_vec()); self.artifacts.insert(port.into(), artifact.clone()); Ok(artifact)
    }
    fn value(&mut self, port: &str, value: Value) -> Result<(), SdkError> { self.values.insert(port.into(), value); Ok(()) }
}

#[derive(Debug, Clone)]
pub struct FixedClock(pub String);
impl Clock for FixedClock { fn now_rfc3339(&self) -> &str { &self.0 } }

#[derive(Debug, Clone)]
pub struct SeededRandom { state: u64, seed_id: String }
impl SeededRandom { pub fn new(seed: u64) -> Self { Self { state: seed, seed_id: format!("seed:{seed}") } } }
impl Randomness for SeededRandom {
    fn fill(&mut self, bytes: &mut [u8]) { for byte in bytes { self.state ^= self.state << 13; self.state ^= self.state >> 7; self.state ^= self.state << 17; *byte = self.state as u8; } }
    fn id(&self) -> &str { &self.seed_id }
}

#[derive(Default, Clone)]
pub struct MemorySecrets(pub BTreeMap<String, Vec<u8>>);
impl MemorySecrets { pub fn insert(&mut self, handle: impl Into<String>, value: impl Into<Vec<u8>>) { self.0.insert(handle.into(), value.into()); } }
impl SecretStore for MemorySecrets { fn resolve(&self, handle: &str) -> Result<Vec<u8>, SdkError> { self.0.get(handle).cloned().ok_or_else(|| SdkError::MissingSecret(handle.into())) } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn context_uses_named_ports_and_limits() {
        let mut reader = MemoryReader::default(); reader.insert("input", b"hello".to_vec());
        let mut outputs = MemoryOutputSink::default(); let cancel = AtomicCancellation::default(); let clock = FixedClock("2025-01-01T00:00:00Z".into()); let mut random = SeededRandom::new(7); let mut secrets = MemorySecrets::default(); secrets.insert("secret:1", b"key".to_vec());
        let mut ctx = ProcessorContext { reader: &mut reader, outputs: &mut outputs, cancellation: &cancel, clock: &clock, randomness: &mut random, secrets: &secrets, limits: Limits { max_output_bytes: 5, ..Limits::default() } };
        assert_eq!(ctx.read("input").unwrap(), b"hello"); assert_eq!(ctx.secret("secret:1").unwrap(), b"key"); assert!(ctx.write("output", b"hello").is_ok()); assert_eq!(ctx.clock.now_rfc3339(), "2025-01-01T00:00:00Z"); cancel.cancel(); assert_eq!(ctx.read("input"), Err(SdkError::Cancelled));
    }
}
