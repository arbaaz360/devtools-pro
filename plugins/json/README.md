# JSON plugin

The first vertical-slice plugin. It defines the canonical format, minify, and
validate operations. The native host currently executes the format and minify
operations through its registered Rust adapter; the package processor remains
the SDK/headless reference implementation.
