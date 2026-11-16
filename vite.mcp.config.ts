import { defineConfig } from 'vite';

// Separate build for the agent page: it never changes the main site's bundle.
export default defineConfig({
  root: 'mcp-page',
  base: '/mcp/',
  build: { outDir: '../dist-mcp', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:4318', '/mcp/api': 'http://127.0.0.1:4320' } },
});
