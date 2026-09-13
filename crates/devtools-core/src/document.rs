use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding { Utf8, Utf8Bom, Utf16Le, Utf16Be, Binary }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NewlineStyle { Lf, Crlf, Cr, Mixed, Unknown }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentKind { Text, Json, Table, Binary }

#[derive(Debug, Clone)]
pub struct Document {
    bytes: Arc<[u8]>,
    pub encoding: Encoding,
    pub newline: NewlineStyle,
    pub mime: Option<String>,
    pub kind: DocumentKind,
}

impl Document {
    pub fn from_bytes(bytes: impl Into<Arc<[u8]>>) -> Self {
        let bytes = bytes.into();
        let (encoding, offset) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { (Encoding::Utf8Bom, 3) }
            else if bytes.starts_with(&[0xFF, 0xFE]) { (Encoding::Utf16Le, 2) }
            else if bytes.starts_with(&[0xFE, 0xFF]) { (Encoding::Utf16Be, 2) }
            else if std::str::from_utf8(&bytes).is_ok() { (Encoding::Utf8, 0) }
            else { (Encoding::Binary, 0) };
        let newline = detect_newline(&bytes[offset..]);
        Self { bytes, encoding, newline, mime: None, kind: DocumentKind::Text }
    }
    pub fn from_text(text: impl AsRef<str>) -> Self { Self::from_bytes(Arc::<[u8]>::from(text.as_ref().as_bytes())) }
    pub fn with_kind(mut self, kind: DocumentKind) -> Self { self.kind = kind; self }
    pub fn with_mime(mut self, mime: impl Into<String>) -> Self { self.mime = Some(mime.into()); self }
    pub fn bytes(&self) -> &[u8] { &self.bytes }
    pub fn len(&self) -> usize { self.bytes.len() }
    /// Returns UTF-8 text without a leading UTF-8 BOM. UTF-16 and binary
    /// documents require an explicit decoding step and return an error here.
    pub fn as_text(&self) -> Result<&str, std::str::Utf8Error> {
        let bytes = if self.encoding == Encoding::Utf8Bom { &self.bytes[3..] } else { &self.bytes };
        std::str::from_utf8(bytes)
    }
}

fn detect_newline(bytes: &[u8]) -> NewlineStyle {
    let mut lf = 0; let mut crlf = 0; let mut cr = 0; let mut i = 0;
    while i < bytes.len() { match bytes[i] { b'\r' if bytes.get(i + 1) == Some(&b'\n') => { crlf += 1; i += 2; }, b'\r' => { cr += 1; i += 1; }, b'\n' => { lf += 1; i += 1; }, _ => i += 1 } }
    match (lf, crlf, cr) { (0, 0, 0) => NewlineStyle::Unknown, (_, 0, 0) => NewlineStyle::Lf, (0, _, 0) => NewlineStyle::Crlf, (0, 0, _) => NewlineStyle::Cr, _ => NewlineStyle::Mixed }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn detects_newlines() { let d = Document::from_text("a\r\nb\r\n"); assert_eq!(d.newline, NewlineStyle::Crlf); }
    #[test] fn clones_immutable_bytes() { let d = Document::from_text("hello"); assert_eq!(d.clone().bytes(), d.bytes()); }
}
