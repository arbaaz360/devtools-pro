import { defineConfig } from 'vite';

// Tauri serves the production bundle from its custom protocol rather than a
// web server root, so assets must resolve relative to the packaged index.
export default defineConfig({ base: './' });
