import { defineConfig } from 'vite';

// Tauri serves the production bundle from its custom protocol rather than a
// web server root, so assets must resolve relative to the packaged index.
// The webview engine bundles the repository's plugin packages and the plugin
// SDK, which live above this app's root; the dev server must be allowed to
// serve them (the production build inlines them).
export default defineConfig({ base: './', server: { fs: { allow: ['../..'] } } });
