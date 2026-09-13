use devtools_core::{inspect_file, transform_json_file, CancellationToken, FileFormat, JsonLayout, ToolError};
use std::{path::PathBuf, time::Duration};

fn usage() -> ! { eprintln!("usage: devtools-cli --file PATH --inspect --format json|csv|text\n       devtools-cli --file PATH --minify|--pretty --output PATH [--cancel-after-ms N]"); std::process::exit(2) }
fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let val = |flag: &str| a.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone());
    let file = val("--file").map(PathBuf::from).unwrap_or_else(|| usage());
    let cancel = CancellationToken::default();
    if let Some(ms) = val("--cancel-after-ms").and_then(|x| x.parse::<u64>().ok()) { let t = cancel.clone(); std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(ms)); t.cancel(); }); }
    let result = if a.iter().any(|x| x == "--inspect") {
        let fmt = match val("--format").as_deref() { Some("json") => FileFormat::Json, Some("csv") => FileFormat::Csv, Some("text") => FileFormat::Text, _ => usage() };
        inspect_file(&file, fmt, &cancel, |_| {})
    } else {
        let output = val("--output").map(PathBuf::from).unwrap_or_else(|| usage());
        let layout = if a.iter().any(|x| x == "--minify") { JsonLayout::Minify } else if a.iter().any(|x| x == "--pretty") { JsonLayout::Pretty } else { usage() };
        transform_json_file(&file, &output, layout, &cancel, |_| {})
    };
    match result { Ok(summary) => println!("{}", serde_json::to_string(&summary).expect("summary serialization")), Err(error) => { eprintln!("{}", serde_json::to_string(&error).unwrap_or_else(|_| format!("{error}"))); std::process::exit(if matches!(error, ToolError::Cancelled) { 130 } else { 1 }); } }
}
