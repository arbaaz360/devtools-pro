use std::{env, path::PathBuf};
use devtools_plugin_discovery::{catalog, discover};

fn main() {
    let mut args = env::args().skip(1); let command = args.next().unwrap_or_else(|| "discover".into());
    let root = PathBuf::from(args.next().unwrap_or_else(|| "plugins".into()));
    match command.as_str() {
        "discover" => match discover(&root) { Ok(packages) => { for package in packages { println!("{}\t{}", package.manifest.id, package.manifest.version); } }, Err(error) => { eprintln!("plugin discovery error: {error}"); std::process::exit(2); } },
        "generate" => { let output = PathBuf::from(args.next().unwrap_or_else(|| "target/generated/plugins".into())); match discover(&root).and_then(|packages| catalog(&packages, &output)) { Ok(()) => println!("generated plugin composition at {}", output.display()), Err(error) => { eprintln!("plugin generation error: {error}"); std::process::exit(2); } } },
        _ => { eprintln!("usage: plugin-discovery [discover <plugins-dir> | generate <plugins-dir> <output-dir>]"); std::process::exit(64); }
    }
}
