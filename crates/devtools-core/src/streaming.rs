use serde::{de::IgnoredAny, Deserialize, Serialize};
use std::{fs::{self, File, OpenOptions}, io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, sync::{atomic::{AtomicBool, Ordering}, Arc}, time::{Duration, Instant}};

const CHUNK: usize = 64 * 1024;
const MAX_DEPTH: usize = 256;
const MAX_PREVIEW: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum FileFormat { Json, Csv, Text }
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum JsonLayout { Pretty, Minify }
#[derive(Debug, Clone, Serialize)] pub struct Progress { pub bytes_processed: u64, pub total_bytes: u64, pub phase: String }
#[derive(Debug, Clone, Serialize)] pub struct Inspection { pub input_bytes: u64, pub output_bytes: Option<u64>, pub elapsed_ms: u64, pub valid: bool, pub summary: String }
#[derive(Debug, Clone, Serialize)] pub struct FilePreview { pub offset: u64, pub total_bytes: u64, pub bytes_read: u64, pub text: String, pub truncated: bool }

#[derive(Debug, Clone, Default)] pub struct CancellationToken(Arc<AtomicBool>);
impl CancellationToken { pub fn cancel(&self) { self.0.store(true, Ordering::Release); } pub fn is_cancelled(&self) -> bool { self.0.load(Ordering::Acquire) } }

fn metadata_len(path: &Path) -> Result<u64, crate::ToolError> { Ok(fs::metadata(path)?.len()) }
fn check_cancel(token: &CancellationToken) -> Result<(), crate::ToolError> { if token.is_cancelled() { Err(crate::ToolError::Cancelled) } else { Ok(()) } }

struct VerifiedReader<R, F> { inner: R, token: CancellationToken, progress: F, total: u64, processed: u64, bom: usize, raw_seen: usize, carry: Vec<u8>, in_string: bool, escaped: bool, depth: usize, scan_structure: bool, failed: Option<crate::ToolError>, last_progress: Instant }
impl<R: Read, F: Fn(Progress)> VerifiedReader<R, F> {
    fn verify_utf8(&mut self, bytes: &[u8]) -> Result<(), crate::ToolError> {
        if bytes.is_empty() { return Ok(()); }
        let mut all = Vec::with_capacity(self.carry.len() + bytes.len()); all.extend_from_slice(&self.carry); all.extend_from_slice(bytes);
        match std::str::from_utf8(&all) {
            Ok(_) => self.carry.clear(),
            Err(e) => { let valid = e.valid_up_to(); if e.error_len().is_some() { return Err(crate::ToolError::InvalidUtf8); } self.carry = all[valid..].to_vec(); if self.carry.len() > 3 { return Err(crate::ToolError::InvalidUtf8); } }
        }
        Ok(())
    }
    fn scan_json(&mut self, bytes: &[u8]) -> Result<(), crate::ToolError> {
        for &b in bytes {
            if self.in_string { if self.escaped { self.escaped = false; } else if b == b'\\' { self.escaped = true; } else if b == b'"' { self.in_string = false; } continue; }
            match b { b'"' => self.in_string = true, b'{' | b'[' => { self.depth += 1; if self.depth > MAX_DEPTH { return Err(crate::ToolError::ResourceLimit { message: format!("JSON nesting exceeds {MAX_DEPTH}") }); } }, b'}' | b']' => { self.depth = self.depth.saturating_sub(1); }, _ => {} }
        }
        Ok(())
    }
}
impl<R: Read, F: Fn(Progress)> Read for VerifiedReader<R, F> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        // Report cancellation as an EOF boundary to consumers such as serde_json.
        // Some deserializers retry Interrupted indefinitely; inspect/transform
        // perform the authoritative token check immediately after the read loop.
        if self.token.is_cancelled() { self.failed = Some(crate::ToolError::Cancelled); return Ok(0); }
        let mut buf = vec![0u8; out.len().max(CHUNK).min(CHUNK)];
        loop {
            let n = self.inner.read(&mut buf)?;
            if n == 0 { if !self.carry.is_empty() { self.failed = Some(crate::ToolError::InvalidUtf8); return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid UTF-8")); } return Ok(0); }
            let raw = &buf[..n]; self.raw_seen += n;
            let skip = self.bom.saturating_sub(self.raw_seen - n);
            let data = &raw[skip..];
            self.processed += n as u64; // processed includes BOM bytes
            if let Err(e) = self.verify_utf8(data).and_then(|_| if self.scan_structure { self.scan_json(data) } else { Ok(()) }) { self.failed = Some(e); return Err(io::Error::new(io::ErrorKind::InvalidData, "input validation failed")); }
            if self.last_progress.elapsed().as_millis() >= 50 || self.processed >= self.total { (self.progress)(Progress { bytes_processed: self.processed.min(self.total), total_bytes: self.total, phase: "reading".into() }); self.last_progress = Instant::now(); }
            if data.is_empty() { continue; }
            let take = data.len().min(out.len()); out[..take].copy_from_slice(&data[..take]);
            // File reads are CHUNK sized; out is also CHUNK in all callers.
            return Ok(take);
        }
    }
}

fn new_reader<F: Fn(Progress)>(file: File, total: u64, token: &CancellationToken, progress: F, bom: usize, scan_structure: bool) -> VerifiedReader<File, F> {
    VerifiedReader { inner: file, token: token.clone(), progress, total, processed: 0, bom, raw_seen: 0, carry: Vec::new(), in_string: false, escaped: false, depth: 0, scan_structure, failed: None, last_progress: Instant::now() - Duration::from_secs(1) }
}

fn parse_json<R: Read>(reader: &mut R) -> Result<(), crate::ToolError> {
    let mut de = serde_json::Deserializer::from_reader(reader);
    IgnoredAny::deserialize(&mut de).map_err(|e| crate::ToolError::InvalidJson { message: e.to_string(), line: e.line(), column: e.column() })?;
    de.end().map_err(|e| crate::ToolError::InvalidJson { message: e.to_string(), line: e.line(), column: e.column() })
}

pub fn inspect_file(path: &Path, format: FileFormat, cancel: &CancellationToken, progress: impl Fn(Progress)) -> Result<Inspection, crate::ToolError> {
    let started = Instant::now(); let total = metadata_len(path)?; let mut file = File::open(path)?;
    let bom = detect_bom(&mut file)?; file.seek(SeekFrom::Start(0))?;
    let mut vr = new_reader(file, total, cancel, progress, bom, matches!(format, FileFormat::Json));
    if matches!(format, FileFormat::Text) {
        let summary = scan_text(&mut vr, total, bom > 0)?;
        check_cancel(cancel)?;
        let summary = serde_json::to_string(&summary).map_err(|e| crate::ToolError::Execution { message: e.to_string() })?;
        return Ok(Inspection { input_bytes: total, output_bytes: None, elapsed_ms: started.elapsed().as_millis() as u64, valid: true, summary });
    }
    let result = match format {
        FileFormat::Json => { let mut br = BufReader::with_capacity(CHUNK, &mut vr); let r = parse_json(&mut br); drop(br); if let Some(e) = vr.failed.take() { return Err(e); } r },
        FileFormat::Csv => scan_csv(&mut vr), FileFormat::Text => unreachable!()
    };
    check_cancel(cancel)?; result?;
    Ok(Inspection { input_bytes: total, output_bytes: None, elapsed_ms: started.elapsed().as_millis() as u64, valid: true, summary: match format { FileFormat::Json => "valid JSON".into(), FileFormat::Csv => "valid CSV".into(), FileFormat::Text => unreachable!() } })
}

fn detect_bom(file: &mut File) -> Result<usize, crate::ToolError> { let mut b = [0u8; 3]; let n = file.read(&mut b)?; file.seek(SeekFrom::Start(0))?; Ok(if n >= 3 && b == [0xEF,0xBB,0xBF] { 3 } else { 0 }) }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextInspectionSummary {
    pub encoding: String,
    pub utf8_bom: bool,
    pub bytes: u64,
    pub content_bytes: u64,
    pub characters: u64,
    pub code_points: u64,
    pub lines: u64,
    pub words: u64,
    pub tabs: u64,
    pub control_characters: u64,
    pub replacement_characters: u64,
    pub newline: TextNewlineSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextNewlineSummary {
    pub style: String,
    pub total: u64,
    pub lf: u64,
    pub crlf: u64,
    pub cr: u64,
}

struct TextStats {
    summary: TextInspectionSummary,
    carry: Vec<u8>,
    pending_cr: bool,
    in_word: bool,
}

impl TextStats {
    fn new(bytes: u64, utf8_bom: bool) -> Self {
        Self { summary: TextInspectionSummary {
            encoding: "UTF-8".into(), utf8_bom, bytes,
            content_bytes: bytes.saturating_sub(if utf8_bom { 3 } else { 0 }),
            characters: 0, code_points: 0, lines: 0, words: 0, tabs: 0,
            control_characters: 0, replacement_characters: 0,
            newline: TextNewlineSummary { style: "none".into(), total: 0, lf: 0, crlf: 0, cr: 0 },
        }, carry: Vec::new(), pending_cr: false, in_word: false }
    }
    fn newline_cr(&mut self) { self.summary.newline.total += 1; self.summary.newline.cr += 1; }
    fn newline_lf(&mut self) { self.summary.newline.total += 1; self.summary.newline.lf += 1; }
    fn push_char(&mut self, c: char) {
        let mut part_of_crlf = false;
        if self.pending_cr {
            if c == '\n' { self.summary.newline.total += 1; self.summary.newline.crlf += 1; self.pending_cr = false; part_of_crlf = true; }
            else {
            self.newline_cr(); self.pending_cr = false;
            }
        }
        self.summary.characters += 1; self.summary.code_points += 1;
        if c == '\r' { self.pending_cr = true; } else if c == '\n' && !part_of_crlf { self.newline_lf(); }
        if c == '\t' { self.summary.tabs += 1; }
        if c.is_control() { self.summary.control_characters += 1; }
        if c == '\u{FFFD}' { self.summary.replacement_characters += 1; }
        if c.is_whitespace() { self.in_word = false; }
        else if !self.in_word { self.summary.words += 1; self.in_word = true; }
    }
    fn push(&mut self, bytes: &[u8]) -> Result<(), crate::ToolError> {
        self.carry.extend_from_slice(bytes);
        let valid = match std::str::from_utf8(&self.carry) {
            Ok(_) => {
                let complete = String::from_utf8(std::mem::take(&mut self.carry)).map_err(|_| crate::ToolError::InvalidUtf8)?;
                for c in complete.chars() { self.push_char(c); }
                return Ok(())
            }
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => return Err(crate::ToolError::InvalidUtf8),
        };
        let complete = String::from_utf8(self.carry[..valid].to_vec()).map_err(|_| crate::ToolError::InvalidUtf8)?;
        for c in complete.chars() { self.push_char(c); }
        self.carry.drain(..valid);
        if self.carry.len() > 3 { return Err(crate::ToolError::InvalidUtf8); }
        Ok(())
    }
    fn finish(mut self) -> Result<TextInspectionSummary, crate::ToolError> {
        if !self.carry.is_empty() { return Err(crate::ToolError::InvalidUtf8); }
        if self.pending_cr { self.newline_cr(); }
        self.summary.lines = if self.summary.characters == 0 { 0 } else { self.summary.newline.total + 1 };
        self.summary.newline.style = match (self.summary.newline.lf > 0, self.summary.newline.crlf > 0, self.summary.newline.cr > 0) {
            (false, false, false) => "none", (true, false, false) => "lf", (false, true, false) => "crlf",
            (false, false, true) => "cr", _ => "mixed",
        }.into();
        Ok(self.summary)
    }
}

fn scan_text<R: Read>(reader: &mut R, total: u64, utf8_bom: bool) -> Result<TextInspectionSummary, crate::ToolError> {
    let mut stats = TextStats::new(total, utf8_bom); let mut b = [0u8; CHUNK];
    loop { let n = reader.read(&mut b).map_err(crate::ToolError::from)?; if n == 0 { break; } stats.push(&b[..n])?; }
    stats.finish()
}

fn scan_csv<R: Read>(reader: &mut R) -> Result<(), crate::ToolError> {
    let mut b = [0u8; CHUNK]; let mut quoted = false; let mut after_quote = false; let mut field_start = true; let mut fields = 1u64; let mut expected = None; let mut record = 1u64; let mut row_has_data = false;
    loop { let n = reader.read(&mut b).map_err(crate::ToolError::from)?; if n == 0 { break; } for &c in &b[..n] { if quoted { if c == b'"' { quoted = false; after_quote = true; } continue; } if after_quote { if c == b'"' { quoted = true; after_quote = false; continue; } if c != b',' && c != b'\r' && c != b'\n' { return Err(crate::ToolError::InvalidCsv { message: "unexpected character after closing quote".into(), record }); } after_quote = false; }
        match c { b'"' if field_start => { quoted = true; row_has_data = true; field_start = false; }, b',' => { fields += 1; row_has_data = true; field_start = true; }, b'\n' => { if quoted { continue; } if let Some(e) = expected { if e != fields { return Err(crate::ToolError::InvalidCsv { message: format!("ragged record: expected {e} fields, got {fields}"), record }); } } else { expected = Some(fields); } record += 1; fields = 1; row_has_data = false; field_start = true; }, b'\r' => {}, _ => { row_has_data = true; field_start = false; } }
    }}
    if quoted { return Err(crate::ToolError::InvalidCsv { message: "unterminated quoted field".into(), record }); }
    if fields > 1 || row_has_data { if let Some(e) = expected { if e != fields { return Err(crate::ToolError::InvalidCsv { message: format!("ragged record: expected {e} fields, got {fields}"), record }); } } }
    Ok(())
}

struct JsonFormatter<W> { out: W, layout: JsonLayout, in_string: bool, escaped: bool, stack: Vec<bool>, after_open: bool }
impl<W: Write> JsonFormatter<W> {
    fn emit(&mut self, bytes: &[u8]) -> io::Result<()> { self.out.write_all(bytes) }
    fn write_chunk(&mut self, bytes: &[u8]) -> io::Result<()> {
        for &b in bytes { if self.in_string { self.emit(&[b])?; if self.escaped { self.escaped = false; } else if b == b'\\' { self.escaped = true; } else if b == b'"' { self.in_string = false; } continue; }
            if b == b'"' { if self.after_open { self.emit(b"\n")?; self.emit(&vec![b' '; self.stack.len()*2])?; self.after_open=false; } self.in_string = true; if let Some(x)=self.stack.last_mut(){*x=true;} self.emit(&[b])?; continue; }
            if b.is_ascii_whitespace() { continue; }
            match self.layout { JsonLayout::Minify => self.emit(&[b])?, JsonLayout::Pretty => match b {
                b'{' | b'[' => { if self.after_open { self.emit(b"\n")?; self.emit(&vec![b' '; self.stack.len()*2])?; } if let Some(x)=self.stack.last_mut(){*x=true;} self.emit(&[b])?; self.stack.push(false); self.after_open=true; },
                b'}' | b']' => { let had = self.stack.pop().unwrap_or(true); if had { self.emit(b"\n")?; self.emit(&vec![b' '; self.stack.len()*2])?; } self.emit(&[b])?; self.after_open=false; },
                b',' => { self.emit(b",\n")?; self.emit(&vec![b' '; self.stack.len()*2])?; self.after_open=false; },
                b':' => self.emit(b": ")?, _ => { if self.after_open { self.emit(b"\n")?; self.emit(&vec![b' '; self.stack.len()*2])?; self.after_open=false; } self.emit(&[b])?; }
            }}
        } Ok(())
    }
}

struct TempOutput { path: PathBuf, committed: bool }
impl Drop for TempOutput { fn drop(&mut self) { if !self.committed { let _ = fs::remove_file(&self.path); } } }
fn make_temp(output: &Path) -> Result<(TempOutput, File), crate::ToolError> { let name = output.file_name().and_then(|x| x.to_str()).unwrap_or("output"); for i in 0..100 { let p = output.with_file_name(format!(".{name}.partial-{}-{i}", std::process::id())); match OpenOptions::new().write(true).create_new(true).open(&p) { Ok(f) => return Ok((TempOutput { path:p, committed:false }, f)), Err(e) if e.kind()==io::ErrorKind::AlreadyExists => continue, Err(e)=>return Err(e.into()) } } Err(crate::ToolError::Execution { message: "could not create unique temporary output".into() }) }

pub fn transform_json_file(input: &Path, output: &Path, layout: JsonLayout, cancel: &CancellationToken, progress: impl Fn(Progress)) -> Result<Inspection, crate::ToolError> {
    if input == output { return Err(crate::ToolError::Execution { message: "input and output paths must differ".into() }); }
    if output.exists() { return Err(crate::ToolError::Execution { message: "output already exists".into() }); }
    let started = Instant::now(); let total = metadata_len(input)?;
    // Validate in a bounded pass before publishing any transformed bytes.
    inspect_file(input, FileFormat::Json, cancel, |p| progress(Progress { phase: "validating".into(), ..p }))?;
    let mut file = File::open(input)?; let bom = detect_bom(&mut file)?; file.seek(SeekFrom::Start(0))?;
    let (mut guard, out_file) = make_temp(output)?; let writer = BufWriter::with_capacity(CHUNK, out_file); let mut formatter = JsonFormatter { out: writer, layout, in_string:false, escaped:false, stack:Vec::new(), after_open:false };
    let mut vr = new_reader(file, total, cancel, progress, bom, true); let mut br = BufReader::with_capacity(CHUNK, &mut vr); let mut b=[0u8; CHUNK];
    loop { let n=match br.read(&mut b) { Ok(n)=>n, Err(_) if cancel.is_cancelled()=>return Err(crate::ToolError::Cancelled), Err(e)=>return Err(e.into()) }; if n==0 { break; } check_cancel(cancel)?; formatter.write_chunk(&b[..n]).map_err(crate::ToolError::from)?; }
    drop(br); check_cancel(cancel)?; if vr.in_string || vr.depth != 0 { return Err(crate::ToolError::InvalidJson { message:"unexpected end of JSON".into(), line:1, column:1 }); }
    formatter.out.flush().map_err(crate::ToolError::from)?; let out_bytes = formatter.out.get_ref().metadata()?.len();
    // hard_link never overwrites an existing destination, providing atomic no-clobber publication.
    fs::hard_link(&guard.path, output).map_err(crate::ToolError::from)?; guard.committed=true; fs::remove_file(&guard.path).ok();
    Ok(Inspection { input_bytes:total, output_bytes:Some(out_bytes), elapsed_ms:started.elapsed().as_millis() as u64, valid:true, summary:match layout { JsonLayout::Pretty=>"JSON formatted".into(), JsonLayout::Minify=>"JSON minified".into() } })
}

pub fn preview_file(path: &Path, offset: u64, max_bytes: usize) -> Result<FilePreview, crate::ToolError> {
    let total=metadata_len(path)?; if offset > total { return Err(crate::ToolError::Execution { message:"offset exceeds file size".into() }); }
    let take=max_bytes.min(MAX_PREVIEW); let mut f=File::open(path)?; f.seek(SeekFrom::Start(offset))?; let mut b=vec![0u8;take]; let n=f.read(&mut b)?; b.truncate(n); let text=String::from_utf8_lossy(&b).into_owned(); Ok(FilePreview { offset,total_bytes:total,bytes_read:n as u64,text,truncated:offset+(n as u64)<total })
}

#[cfg(test)] mod tests {
    use super::*; use std::io::Write;
    fn file(name:&str,s:&str)->PathBuf {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p=std::env::temp_dir().join(format!("devtools-{name}-{}-{nonce}",std::process::id()));
        let mut f=File::create(&p).unwrap(); f.write_all(s.as_bytes()).unwrap(); p
    }
    #[test] fn cancel_token() { let t=CancellationToken::default(); t.cancel(); assert!(t.is_cancelled()); }
    #[test] fn json_stream_preserves_lexemes() { let i=file("j",r#"{"a":1.2300,"a":2}"#); let o=i.with_extension("out"); let t=CancellationToken::default(); transform_json_file(&i,&o,JsonLayout::Minify,&t, |_|{}).unwrap(); assert_eq!(std::fs::read_to_string(&o).unwrap(),r#"{"a":1.2300,"a":2}"#); let _=std::fs::remove_file(i); let _=std::fs::remove_file(o); }
    #[test] fn invalid_and_csv_ragged() { let i=file("bad", "{bad"); assert!(inspect_file(&i,FileFormat::Json,&CancellationToken::default(), |_|{}).is_err()); let c=file("csv","a,b\n1\n"); assert!(inspect_file(&c,FileFormat::Csv,&CancellationToken::default(), |_|{}).is_err()); }
    #[test] fn text_inspection_reports_explicit_unicode_and_newline_stats() {
        let i=file("text-stats", "one\r\ntwo\nthree\rfour\t\u{FFFD}");
        let result=inspect_file(&i,FileFormat::Text,&CancellationToken::default(), |_|{}).unwrap();
        let summary: TextInspectionSummary=serde_json::from_str(&result.summary).unwrap();
        assert_eq!(summary.bytes, "one\r\ntwo\nthree\rfour\t\u{FFFD}".as_bytes().len() as u64);
        assert_eq!(summary.characters, 21); assert_eq!(summary.code_points, 21);
        assert_eq!(summary.words, 5); assert_eq!(summary.tabs, 1); assert_eq!(summary.replacement_characters, 1);
        assert_eq!(summary.newline.style, "mixed"); assert_eq!(summary.newline.crlf, 1); assert_eq!(summary.newline.lf, 1); assert_eq!(summary.newline.cr, 1);
        assert_eq!(summary.lines, 4);
        let _=std::fs::remove_file(i);
    }
}
