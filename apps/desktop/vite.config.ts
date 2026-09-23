import { defineConfig } from 'vite';

// Tauri serves the production bundle from its custom protocol rather than a
// web server root, so assets must resolve relative to the packaged index.
// The webview engine bundles the repository's plugin packages and the plugin
// SDK, which live above this app's root; the dev server must be allowed to
// serve them (the production build inlines them).
// `vite preview` stands in for the dev URL a debug build loads, and the webview
// caches what it serves: without this a rebuilt bundle can render as the previous
// one, and a test suite then reports on the wrong code while passing.
export default defineConfig({
  base: './',
  server: { fs: { allow: ['../..'] } },
  preview: { headers: { 'Cache-Control': 'no-store' } },
});
