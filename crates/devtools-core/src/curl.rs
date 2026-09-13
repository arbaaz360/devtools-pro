use crate::{Document, DocumentKind, Diagnostic, GenericTool, InputKind, RendererKind, Severity, ToolCapabilities, ToolError, ToolLimits, ToolManifest, ToolOperation, ToolResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CurlRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub query: Vec<(String, String)>,
    pub body: Option<String>,
}

fn diag(message: impl Into<String>, start: usize, end: usize) -> Diagnostic {
    Diagnostic { severity: Severity::Error, message: message.into(), start, end }
}

/// Parse a shell-like cURL command without executing it. Only quoting and
/// backslash escaping are interpreted; shell expansion and composition are
/// deliberately rejected.
pub fn parse_curl(input: &str) -> Result<(CurlRequest, Vec<Diagnostic>), Vec<Diagnostic>> {
    let mut tokens = Vec::<(String, usize)>::new();
    let mut cur = String::new(); let mut start = 0usize; let mut i = 0usize; let mut quote = None;
    let bytes = input.as_bytes();
    while i < bytes.len() {
        let c = bytes[i] as char;
        if let Some(q) = quote {
            if c == q { quote = None; i += 1; continue; }
            if q == '\'' { cur.push(c); i += 1; continue; }
            if c == '\\' {
                i += 1; if i >= bytes.len() { return Err(vec![diag("trailing backslash in quoted argument", start, bytes.len())]); }
                cur.push(bytes[i] as char); i += 1; continue;
            }
            cur.push(c); i += 1; continue;
        }
        if c == '\'' || c == '"' { if cur.is_empty() { start = i; } quote = Some(c); i += 1; continue; }
        if c == '\\' { if cur.is_empty() { start = i; } i += 1; if i >= bytes.len() { return Err(vec![diag("trailing backslash", start, bytes.len())]); } cur.push(bytes[i] as char); i += 1; continue; }
        if c.is_whitespace() { if !cur.is_empty() { tokens.push((std::mem::take(&mut cur), start)); } i += 1; continue; }
        if ";|&<>`$".contains(c) { return Err(vec![diag(format!("unsafe shell construct '{c}'; remove shell operators and provide literal arguments"), i, i + 1)]); }
        if cur.is_empty() { start = i; } cur.push(c); i += 1;
    }
    if quote.is_some() { return Err(vec![diag("unterminated quoted argument", start, bytes.len())]); }
    if !cur.is_empty() { tokens.push((cur, start)); }
    if tokens.first().map(|t| t.0.as_str()) != Some("curl") { return Err(vec![diag("command must start with curl", 0, input.len().min(4))]); }
    let mut url = None; let mut method = None; let mut headers = Vec::new(); let mut body = None; let mut j = 1;
    while j < tokens.len() {
        let (tok, pos) = &tokens[j];
        if tok.starts_with("$") || tok.contains("${") { return Err(vec![diag("shell variables are not supported; replace with a literal value", *pos, *pos + tok.len())]); }
        match tok.as_str() {
            "-X" | "--request" => { j += 1; if j >= tokens.len() { return Err(vec![diag("--request requires a method", *pos, *pos + tok.len())]); } method = Some(tokens[j].0.to_uppercase()); }
            "-H" | "--header" => { j += 1; if j >= tokens.len() { return Err(vec![diag("--header requires 'Name: value'", *pos, *pos + tok.len())]); } let h = &tokens[j].0; let Some(k) = h.find(':') else { return Err(vec![diag("header must use 'Name: value'", tokens[j].1, tokens[j].1 + h.len())]); }; headers.push((h[..k].trim().to_string(), h[k+1..].trim().to_string())); }
            "-d" | "--data" | "--data-raw" | "--data-binary" | "--json" => { j += 1; if j >= tokens.len() { return Err(vec![diag("data option requires a body", *pos, *pos + tok.len())]); } body = Some(tokens[j].0.clone()); if tok == "--json" && !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) { headers.push(("Content-Type".into(), "application/json".into())); } if tok == "-d" || tok == "--data" { method.get_or_insert_with(|| "POST".into()); } }
            "--url" => { j += 1; if j >= tokens.len() { return Err(vec![diag("--url requires a URL", *pos, *pos + tok.len())]); } url = Some(tokens[j].0.clone()); }
            t if t.starts_with('-') => return Err(vec![diag(format!("unsupported cURL option '{t}'; remove it or provide a literal equivalent"), *pos, *pos + tok.len())]),
            t => { if url.is_some() { return Err(vec![diag(format!("unexpected argument '{t}'"), *pos, *pos + tok.len())]); } url = Some(t.to_string()); }
        }
        j += 1;
    }
    let Some(url) = url else { return Err(vec![diag("missing URL", input.len(), input.len())]); };
    if !(url.starts_with("http://") || url.starts_with("https://")) { return Err(vec![diag("URL must use http:// or https://", 0, input.len())]); }
    let query = url.split_once('?').map(|(_, q)| q.split('&').filter_map(|p| { let mut x = p.splitn(2, '='); Some((x.next()?.to_string(), x.next().unwrap_or("").to_string())) }).collect()).unwrap_or_default();
    let method = method.unwrap_or_else(|| if body.is_some() { "POST".into() } else { "GET".into() });
    Ok((CurlRequest { url, method, headers, query, body }, Vec::new()))
}

pub fn generate_fetch(r: &CurlRequest) -> String {
    let mut s = format!("// cURL source: URL={} method={}\nconst response = await fetch({}, {{\n  method: {:?},", r.url, r.method, serde_json::to_string(&r.url).unwrap(), r.method);
    if !r.headers.is_empty() { s.push_str("\n  headers: {"); for (k,v) in &r.headers { s.push_str(&format!("\n    {:?}: {:?},", k, v)); } s.push_str("\n  },"); }
    if let Some(b) = &r.body { s.push_str(&format!("\n  body: {},", serde_json::to_string(b).unwrap())); }
    s.push_str("\n});\nconst data = await response.text();"); s
}

pub fn generate_python(r: &CurlRequest) -> String {
    let mut s = format!("# cURL source: URL={} method={}\nimport requests\n\nresponse = requests.request({:?}, {:?}", r.url, r.method, r.method, r.url);
    if !r.headers.is_empty() { s.push_str(", headers={"); for (k,v) in &r.headers { s.push_str(&format!("{:?}: {:?}, ", k, v)); } s.push('}'); }
    if let Some(b) = &r.body { s.push_str(&format!(", data={:?}", b)); }
    s.push_str(")\nprint(response.text)"); s
}

pub struct CurlTool { manifest: ToolManifest }
impl CurlTool { pub fn new() -> Self { Self { manifest: ToolManifest { id: "web.curl-code".into(), label: "cURL to Code".into(), contract_version: 1, input_kinds: vec![InputKind::Text], limits: ToolLimits { max_input_bytes: Some(1024 * 1024), max_output_bytes: Some(4 * 1024 * 1024) }, capabilities: ToolCapabilities { deterministic:true, supports_preview:true, supports_streaming:false, cancellation:true, progress:false, needs_filesystem:false, needs_network:false, needs_secrets:false }, operations: vec![ToolOperation{id:"fetch".into(),label:"Generate fetch".into(),default_options:Value::Object(Default::default())}, ToolOperation{id:"python".into(),label:"Generate Python requests".into(),default_options:Value::Object(Default::default())}], renderer: RendererKind::Text } } } }
impl Default for CurlTool { fn default() -> Self { Self::new() } }
impl GenericTool for CurlTool { fn manifest(&self)->&ToolManifest { &self.manifest } fn execute(&self, op:&str, input:&Document, _options:&Value)->Result<ToolResult,ToolError>{ let text=input.as_text().map_err(|_| ToolError::InvalidUtf8)?; let (r, d)=parse_curl(text).map_err(|ds| ToolError::Execution{message: ds.into_iter().map(|d| d.message).collect::<Vec<_>>().join("; ")})?; let out=match op {"fetch"=>generate_fetch(&r),"python"=>generate_python(&r), _=>return Err(ToolError::UnsupportedOperation{tool_id:self.manifest.id.clone(),operation_id:op.into()})}; Ok(ToolResult{output:Document::from_text(out).with_kind(DocumentKind::Text).with_mime("text/plain"),diagnostics:d}) } }

#[cfg(test)]
mod tests { use super::*; #[test] fn parses_get_query(){let (r,_)=parse_curl("curl 'https://example.test/a?x=1&y=two'").unwrap(); assert_eq!(r.method,"GET"); assert_eq!(r.query.len(),2);} #[test] fn parses_post_json_and_quotes(){let (r,_)=parse_curl("curl -X POST -H 'X-Test: yes' --json '{\"name\":\"a b\"}' https://e.test").unwrap(); assert_eq!(r.method,"POST"); assert_eq!(r.headers[0].0,"X-Test"); assert!(generate_fetch(&r).contains("a b"));} #[test] fn rejects_shell(){let e=parse_curl("curl https://e.test | sh").unwrap_err(); assert!(e[0].message.contains("unsafe shell"));} #[test] fn malformed(){assert!(parse_curl("curl -H nope https://e.test").is_err()); assert!(parse_curl("curl 'https://e.test").is_err());} }
