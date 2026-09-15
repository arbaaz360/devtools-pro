use crate::{CancellationToken, Document, DocumentKind, GenericTool, InputKind, RendererKind, ToolCapabilities, ToolError, ToolLimits, ToolManifest, ToolOperation, ToolResult};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_MAX_INPUT_BYTES: usize = 36 * 1024 * 1024;
pub const DEFAULT_MAX_DECODED_BYTES: usize = 25 * 1024 * 1024;
pub const DEFAULT_MAX_PIXELS: u64 = 100_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Base64ImageOptions {
    pub mime_type: Option<String>,
    pub max_input_bytes: Option<usize>,
    pub max_decoded_bytes: Option<usize>,
    pub max_pixels: Option<u64>,
}
impl Default for Base64ImageOptions {
    fn default() -> Self { Self { mime_type: None, max_input_bytes: Some(DEFAULT_MAX_INPUT_BYTES), max_decoded_bytes: Some(DEFAULT_MAX_DECODED_BYTES), max_pixels: Some(DEFAULT_MAX_PIXELS) } }
}

#[derive(Debug, Clone, Serialize)]
pub struct Base64ImageStats { pub format: crate::ImageFormat, pub mime: &'static str, pub extension: &'static str, pub input_bytes: u64, pub output_bytes: u64 }

fn parse_input(input: &str) -> Result<(String, &str), ToolError> {
    let trimmed = input.trim();
    if let Some((header, payload)) = trimmed.split_once(',') {
        let lower = header.to_ascii_lowercase();
        if !lower.starts_with("data:image/") || !lower.contains(";base64") { return Err(ToolError::InvalidBase64 { message: "data URI must be data:image/...;base64".into() }); }
        let mime = header[5..].split(';').next().unwrap_or_default().to_ascii_lowercase();
        return Ok((mime, payload));
    }
    Ok((String::new(), trimmed))
}

fn decoded_len(payload: &str) -> Result<usize, ToolError> {
    let n = payload.bytes().filter(|b| !b.is_ascii_whitespace()).count();
    if n == 0 || n % 4 != 0 { return Err(ToolError::InvalidBase64 { message: "length must be a non-zero multiple of four".into() }); }
    let padding = payload.bytes().rev().take_while(|b| *b == b'=').count();
    if padding > 2 { return Err(ToolError::InvalidBase64 { message: "invalid padding".into() }); }
    Ok((n / 4) * 3 - padding)
}

fn check_dimensions(bytes: &[u8], format: crate::ImageFormat, max_pixels: u64) -> Result<(), ToolError> {
    let (w, h) = match format {
        crate::ImageFormat::Png if bytes.len() >= 24 && &bytes[12..16] == b"IHDR" => (u32::from_be_bytes(bytes[16..20].try_into().unwrap()) as u64, u32::from_be_bytes(bytes[20..24].try_into().unwrap()) as u64),
        crate::ImageFormat::Png if bytes.len() >= 24 => return Err(ToolError::InvalidImage { message: "PNG IHDR chunk is missing".into() }),
        crate::ImageFormat::Png => return Err(ToolError::InvalidImage { message: "truncated PNG header".into() }),
        crate::ImageFormat::Jpeg => {
            let mut i = 2;
            let mut dims = None;
            while i + 9 < bytes.len() {
                if bytes[i] != 0xff { i += 1; continue; }
                let marker = bytes[i + 1]; i += 2;
                if marker == 0xd8 || marker == 0xd9 || marker == 0x01 { continue; }
                if i + 2 > bytes.len() { break; }
                let len = u16::from_be_bytes([bytes[i], bytes[i + 1]]) as usize;
                if len < 2 || i + len > bytes.len() { break; }
                if (0xc0..=0xc3).contains(&marker) || (0xc5..=0xc7).contains(&marker) || (0xc9..=0xcb).contains(&marker) || (0xcd..=0xcf).contains(&marker) {
                    if len >= 7 { dims = Some((u16::from_be_bytes([bytes[i + 3], bytes[i + 4]]) as u64, u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u64)); }
                    break;
                }
                i += len;
            }
            dims.ok_or_else(|| ToolError::InvalidImage { message: "JPEG dimensions unavailable".into() })?
        }
    };
    if w == 0 || h == 0 || w.saturating_mul(h) > max_pixels { return Err(ToolError::ResourceLimit { message: format!("image dimensions exceed {max_pixels} pixels") }); }
    Ok(())
}

pub fn decode_base64_image(input: &Document, options: &Base64ImageOptions, cancel: &CancellationToken, progress: impl Fn(crate::Progress)) -> Result<(ToolResult, Base64ImageStats), ToolError> {
    let text = input.as_text().map_err(|_| ToolError::InvalidUtf8)?;
    let (uri_mime, payload) = parse_input(text)?;
    let max_input = options.max_input_bytes.unwrap_or(DEFAULT_MAX_INPUT_BYTES).min(DEFAULT_MAX_INPUT_BYTES);
    if text.len() > max_input { return Err(ToolError::ResourceLimit { message: format!("Base64 input exceeds {max_input} bytes") }); }
    let expected = decoded_len(payload)?;
    let max_decoded = options.max_decoded_bytes.unwrap_or(DEFAULT_MAX_DECODED_BYTES).min(DEFAULT_MAX_DECODED_BYTES);
    if expected > max_decoded { return Err(ToolError::ResourceLimit { message: format!("decoded image exceeds {max_decoded} bytes") }); }
    if cancel.is_cancelled() { return Err(ToolError::Cancelled); }
    let mut compact = String::with_capacity(payload.len());
    for chunk in payload.as_bytes().chunks(64 * 1024) { if cancel.is_cancelled() { return Err(ToolError::Cancelled); } compact.extend(chunk.iter().filter(|b| !b.is_ascii_whitespace()).map(|b| *b as char)); progress(crate::Progress { bytes_processed: compact.len() as u64, total_bytes: payload.len() as u64, phase: "decoding".into() }); }
    let bytes = STANDARD.decode(compact.as_bytes()).map_err(|e| ToolError::InvalidBase64 { message: e.to_string() })?;
    if bytes.len() != expected { return Err(ToolError::InvalidBase64 { message: "decoded length mismatch".into() }); }
    let explicit = options.mime_type.as_deref().or((!uri_mime.is_empty()).then_some(uri_mime.as_str()));
    let format = crate::image_base64::detect_image_format(&bytes, explicit)?;
    check_dimensions(&bytes, format, options.max_pixels.unwrap_or(DEFAULT_MAX_PIXELS))?;
    let output = Document::from_bytes(bytes).with_kind(DocumentKind::Binary).with_mime(format.mime());
    Ok((ToolResult { output, diagnostics: Vec::new() }, Base64ImageStats { format, mime: format.mime(), extension: format.extension(), input_bytes: text.len() as u64, output_bytes: expected as u64 }))
}

pub struct Base64ImageTool { manifest: ToolManifest }
impl Default for Base64ImageTool { fn default() -> Self { Self { manifest: ToolManifest { id: "encoding.base64-image".into(), label: "Base64 to Image".into(), contract_version: 1, input_kinds: vec![InputKind::Text], limits: ToolLimits { max_input_bytes: Some(DEFAULT_MAX_INPUT_BYTES as u64), max_output_bytes: Some(DEFAULT_MAX_DECODED_BYTES as u64) }, capabilities: ToolCapabilities { deterministic:true, supports_preview:true, supports_streaming:true, cancellation:true, progress:true, needs_filesystem:false, needs_network:false, needs_secrets:false }, operations: vec![ToolOperation { id:"decode".into(), label:"Decode".into(), default_options: serde_json::json!({}) }], renderer: RendererKind::Binary } } } }
impl GenericTool for Base64ImageTool { fn manifest(&self) -> &ToolManifest { &self.manifest } fn execute(&self, operation_id: &str, input: &Document, options: &Value) -> Result<ToolResult, ToolError> { if operation_id != "decode" { return Err(ToolError::UnsupportedOperation { tool_id:self.manifest.id.clone(), operation_id:operation_id.into() }); } let opts: Base64ImageOptions = serde_json::from_value(options.clone()).map_err(|e| ToolError::InvalidOptions { message:e.to_string() })?; decode_base64_image(input, &opts, &CancellationToken::default(), |_| {}).map(|x| x.0) } }

#[cfg(test)] mod tests {
    use super::*;
    use crate::encode_image_base64;
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\06\0\0\0";
    const JPEG: &[u8] = b"\xff\xd8\xff\xc0\0\x0b\x08\0\x01\0\x01\x01\x01\x11\0\xff\xd9";

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffff;
        for &byte in bytes {
            crc ^= byte as u32;
            for _ in 0..8 { crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 }; }
        }
        !crc
    }

    fn append_chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        png.extend_from_slice(&(data.len() as u32).to_be_bytes());
        png.extend_from_slice(kind);
        png.extend_from_slice(data);
        let mut crc_input = Vec::with_capacity(kind.len() + data.len());
        crc_input.extend_from_slice(kind);
        crc_input.extend_from_slice(data);
        png.extend_from_slice(&crc32(&crc_input).to_be_bytes());
    }

    fn large_png() -> Vec<u8> {
        const WIDTH: usize = 1024;
        const HEIGHT: usize = 256;
        let mut raw = Vec::with_capacity((WIDTH * 4 + 1) * HEIGHT);
        for y in 0..HEIGHT {
            raw.push(0);
            for x in 0..WIDTH { raw.extend_from_slice(&[(x & 0xff) as u8, (y & 0xff) as u8, 0x7f, 0xff]); }
        }
        let mut zlib = vec![0x78, 0x01];
        let block_count = (raw.len() + 65_534) / 65_535;
        for (index, block) in raw.chunks(65_535).enumerate() {
            zlib.push(if index + 1 == block_count { 1 } else { 0 });
            let len = block.len() as u16;
            zlib.extend_from_slice(&len.to_le_bytes());
            zlib.extend_from_slice(&(!len).to_le_bytes());
            zlib.extend_from_slice(block);
        }
        let mut adler_a = 1u32;
        let mut adler_b = 0u32;
        for &byte in &raw { adler_a = (adler_a + byte as u32) % 65_521; adler_b = (adler_b + adler_a) % 65_521; }
        zlib.extend_from_slice(&((adler_b << 16) | adler_a).to_be_bytes());
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut ihdr = Vec::with_capacity(13);
        ihdr.extend_from_slice(&(WIDTH as u32).to_be_bytes());
        ihdr.extend_from_slice(&(HEIGHT as u32).to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        append_chunk(&mut png, b"IHDR", &ihdr);
        append_chunk(&mut png, b"IDAT", &zlib);
        append_chunk(&mut png, b"IEND", &[]);
        png
    }
    #[test]
    fn roundtrips_large_png_from_encoder() {
        let png = large_png();
        let image = Document::from_bytes(png.clone()).with_kind(DocumentKind::Binary);
        let (encoded, _) = encode_image_base64(&image, &crate::ImageBase64Options::default(), &CancellationToken::default(), |_| {}).unwrap();
        assert!(encoded.output.len() > 1024 * 1024);
        let (decoded, _) = decode_base64_image(&encoded.output, &Default::default(), &CancellationToken::default(), |_| {}).unwrap();
        assert_eq!(decoded.output.bytes(), png.as_slice());
    }

    #[test]
    fn codec_resource_boundaries_match_manifests() {
        assert_eq!(crate::ImageBase64Tool::default().manifest().limits.max_input_bytes, Some(crate::image_base64::DEFAULT_MAX_INPUT_BYTES as u64));
        assert_eq!(crate::ImageBase64Tool::default().manifest().limits.max_output_bytes, Some(crate::image_base64::DEFAULT_MAX_OUTPUT_BYTES as u64));
        assert_eq!(Base64ImageTool::default().manifest().limits.max_input_bytes, Some(DEFAULT_MAX_INPUT_BYTES as u64));
        assert_eq!(Base64ImageTool::default().manifest().limits.max_output_bytes, Some(DEFAULT_MAX_DECODED_BYTES as u64));

        let mut bytes = vec![0u8; crate::image_base64::DEFAULT_MAX_INPUT_BYTES];
        bytes[..PNG.len()].copy_from_slice(PNG);
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..24].copy_from_slice(&[0, 0, 0, 1, 0, 0, 0, 1]);
        let image = Document::from_bytes(bytes).with_kind(DocumentKind::Binary);
        let (encoded, _) = encode_image_base64(&image, &crate::ImageBase64Options::default(), &CancellationToken::default(), |_| {}).unwrap();
        assert!(encoded.output.len() <= crate::image_base64::DEFAULT_MAX_OUTPUT_BYTES);
        let (decoded, _) = decode_base64_image(&encoded.output, &Default::default(), &CancellationToken::default(), |_| {}).unwrap();
        assert_eq!(decoded.output.len(), crate::image_base64::DEFAULT_MAX_INPUT_BYTES);

        let oversized = Document::from_text("A".repeat(DEFAULT_MAX_INPUT_BYTES + 1));
        assert!(matches!(decode_base64_image(&oversized, &Default::default(), &CancellationToken::default(), |_| {}), Err(ToolError::ResourceLimit { .. })));
    }

    #[test] fn decodes_plain_and_data_uri() { let b = STANDARD.encode(PNG); for s in [b.clone(), format!("data:image/png;base64,{b}")] { let (r, _) = decode_base64_image(&Document::from_text(s), &Default::default(), &CancellationToken::default(), |_| {}).unwrap(); assert_eq!(r.output.bytes(), PNG); assert_eq!(r.output.mime.as_deref(), Some("image/png")); } }
    #[test] fn rejects_malformed_mime_and_limits() { let d=Document::from_text("abcd="); assert!(matches!(decode_base64_image(&d,&Default::default(),&CancellationToken::default(), |_| {}),Err(ToolError::InvalidBase64{..}))); let b=STANDARD.encode(PNG); let d=Document::from_text(b); let o=Base64ImageOptions{max_decoded_bytes:Some(2),..Default::default()}; assert!(matches!(decode_base64_image(&d,&o,&CancellationToken::default(), |_| {}),Err(ToolError::ResourceLimit{..}))); }
    #[test] fn rejects_mismatched_mime_and_cancel() { let b=STANDARD.encode(PNG); let d=Document::from_text(format!("data:image/jpeg;base64,{b}")); assert!(matches!(decode_base64_image(&d,&Default::default(),&CancellationToken::default(), |_| {}),Err(ToolError::InvalidImage{..}))); let t=CancellationToken::default(); t.cancel(); assert!(matches!(decode_base64_image(&Document::from_text(STANDARD.encode(PNG)),&Default::default(),&t, |_| {}),Err(ToolError::Cancelled))); }
    #[test] fn decodes_jpeg_with_canonical_metadata() { let b = STANDARD.encode(JPEG); let (result, stats) = decode_base64_image(&Document::from_text(format!("data:image/jpeg;base64,{b}")), &Default::default(), &CancellationToken::default(), |_| {}).unwrap(); assert_eq!(result.output.mime.as_deref(), Some("image/jpeg")); assert_eq!(stats.extension, "jpg"); assert_eq!(result.output.bytes(), JPEG); }
    #[test] fn rejects_unsupported_mime_and_malformed_signature() { let b = STANDARD.encode(PNG); let unsupported = Document::from_text(format!("data:image/gif;base64,{b}")); assert!(matches!(decode_base64_image(&unsupported, &Default::default(), &CancellationToken::default(), |_| {}), Err(ToolError::UnsupportedImageMime { .. }))); let malformed = Document::from_text(STANDARD.encode(b"not an image")); assert!(matches!(decode_base64_image(&malformed, &Default::default(), &CancellationToken::default(), |_| {}), Err(ToolError::InvalidImage { .. }))); }
}
