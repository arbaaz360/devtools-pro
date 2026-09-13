use crate::{CancellationToken, Document, DocumentKind, GenericTool, InputKind, RendererKind, ToolError, ToolLimits, ToolManifest, ToolOperation, ToolResult, ToolCapabilities};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_MAX_INPUT_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat { Png, Jpeg }

impl ImageFormat {
    pub fn mime(self) -> &'static str { match self { Self::Png => "image/png", Self::Jpeg => "image/jpeg" } }
    fn signature(self) -> &'static [u8] { match self { Self::Png => b"\x89PNG\r\n\x1a\n", Self::Jpeg => b"\xff\xd8\xff" } }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImageBase64Options {
    pub data_uri: bool,
    pub mime_type: Option<String>,
    pub max_input_bytes: Option<usize>,
}
impl Default for ImageBase64Options { fn default() -> Self { Self { data_uri: false, mime_type: None, max_input_bytes: Some(DEFAULT_MAX_INPUT_BYTES) } } }

#[derive(Debug, Clone, Serialize)]
pub struct ImageBase64Stats { pub format: ImageFormat, pub input_bytes: u64, pub output_bytes: u64, pub data_uri: bool }

pub fn detect_image_format(bytes: &[u8], explicit_mime: Option<&str>) -> Result<ImageFormat, ToolError> {
    let detected = if bytes.starts_with(ImageFormat::Png.signature()) { Some(ImageFormat::Png) }
        else if bytes.starts_with(ImageFormat::Jpeg.signature()) { Some(ImageFormat::Jpeg) } else { None };
    if let Some(mime) = explicit_mime {
        let requested = match mime.to_ascii_lowercase().as_str() { "image/png" => ImageFormat::Png, "image/jpeg" | "image/jpg" => ImageFormat::Jpeg, _ => return Err(ToolError::UnsupportedImageMime { mime: mime.into() }) };
        if detected.is_some_and(|actual| actual != requested) { return Err(ToolError::InvalidImage { message: "MIME type does not match the image signature".into() }); }
        return Ok(requested);
    }
    detected.ok_or_else(|| ToolError::InvalidImage { message: "unrecognized PNG or JPEG signature".into() })
}

/// Encode immutable image bytes while checking cancellation and reporting bounded progress.
pub fn encode_image_base64(input: &Document, options: &ImageBase64Options, cancel: &CancellationToken, progress: impl Fn(crate::Progress)) -> Result<(ToolResult, ImageBase64Stats), ToolError> {
    let max = options.max_input_bytes.unwrap_or(DEFAULT_MAX_INPUT_BYTES).min(DEFAULT_MAX_INPUT_BYTES);
    if input.len() > max { return Err(ToolError::ResourceLimit { message: format!("image exceeds the {max}-byte limit") }); }
    let format = detect_image_format(input.bytes(), options.mime_type.as_deref().or(input.mime.as_deref()))?;
    let total = input.len() as u64;
    let mut encoded = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.bytes().chunks(3 * 1024) {
        if cancel.is_cancelled() { return Err(ToolError::Cancelled); }
        encoded.push_str(&STANDARD.encode(chunk));
        progress(crate::Progress { bytes_processed: (encoded.len() as u64 * 3 / 4).min(total), total_bytes: total, phase: "encoding".into() });
    }
    if options.data_uri { encoded = format!("data:{};base64,{}", format.mime(), encoded); }
    let output_bytes = encoded.len() as u64;
    Ok((ToolResult { output: Document::from_text(&encoded).with_kind(DocumentKind::Text).with_mime("text/plain"), diagnostics: Vec::new() }, ImageBase64Stats { format, input_bytes: total, output_bytes, data_uri: options.data_uri }))
}

pub struct ImageBase64Tool { manifest: ToolManifest }
impl Default for ImageBase64Tool { fn default() -> Self { Self { manifest: ToolManifest { id: "encoding.image-base64".into(), label: "Image to Base64".into(), contract_version: 1, input_kinds: vec![InputKind::Bytes], limits: ToolLimits { max_input_bytes: Some(DEFAULT_MAX_INPUT_BYTES as u64), max_output_bytes: None }, capabilities: ToolCapabilities { deterministic: true, supports_preview: true, supports_streaming: true, cancellation: true, progress: true, needs_filesystem: false, needs_network: false, needs_secrets: false }, operations: vec![ToolOperation { id: "encode".into(), label: "Encode".into(), default_options: serde_json::json!({"dataUri": false}) }], renderer: RendererKind::Text } } } }
impl GenericTool for ImageBase64Tool {
    fn manifest(&self) -> &ToolManifest { &self.manifest }
    fn execute(&self, operation_id: &str, input: &Document, options: &Value) -> Result<ToolResult, ToolError> {
        if operation_id != "encode" { return Err(ToolError::UnsupportedOperation { tool_id: self.manifest.id.clone(), operation_id: operation_id.into() }); }
        let opts: ImageBase64Options = serde_json::from_value(options.clone()).map_err(|e| ToolError::InvalidOptions { message: e.to_string() })?;
        encode_image_base64(input, &opts, &CancellationToken::default(), |_| {}).map(|(result, _)| result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";
    const JPEG: &[u8] = b"\xff\xd8\xff\xe0fixture";
    #[test] fn encodes_png_and_jpeg_without_source_bytes() { for (bytes, expected) in [(PNG, "iVBORw0KGgp"), (JPEG, "/9j/4G") ] { let d = Document::from_bytes(bytes.to_vec()).with_kind(DocumentKind::Binary); let (r, s) = encode_image_base64(&d, &ImageBase64Options::default(), &CancellationToken::default(), |_| {}).unwrap(); assert!(r.output.as_text().unwrap().starts_with(expected)); assert_eq!(s.input_bytes, bytes.len() as u64); assert!(!r.output.as_text().unwrap().contains("fixture")); } }
    #[test] fn data_uri_and_explicit_mime_are_supported() { let d = Document::from_bytes(PNG.to_vec()).with_kind(DocumentKind::Binary); let o = ImageBase64Options { data_uri: true, mime_type: Some("image/png".into()), ..Default::default() }; let (r, _) = encode_image_base64(&d, &o, &CancellationToken::default(), |_| {}).unwrap(); assert!(r.output.as_text().unwrap().starts_with("data:image/png;base64,")); }
    #[test] fn invalid_and_mismatched_images_fail() { let d = Document::from_bytes(b"bad".to_vec()).with_kind(DocumentKind::Binary); assert!(matches!(encode_image_base64(&d, &Default::default(), &CancellationToken::default(), |_| {}), Err(ToolError::InvalidImage { .. }))); let d = Document::from_bytes(PNG.to_vec()).with_kind(DocumentKind::Binary); let o = ImageBase64Options { mime_type: Some("image/jpeg".into()), ..Default::default() }; assert!(matches!(encode_image_base64(&d, &o, &CancellationToken::default(), |_| {}), Err(ToolError::InvalidImage { .. }))); }
    #[test] fn limit_and_cancellation_are_enforced() { let d = Document::from_bytes(PNG.to_vec()).with_kind(DocumentKind::Binary); let o = ImageBase64Options { max_input_bytes: Some(2), ..Default::default() }; assert!(matches!(encode_image_base64(&d, &o, &CancellationToken::default(), |_| {}), Err(ToolError::ResourceLimit { .. }))); let t = CancellationToken::default(); t.cancel(); assert!(matches!(encode_image_base64(&d, &Default::default(), &t, |_| {}), Err(ToolError::Cancelled))); }
}
