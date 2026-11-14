import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { fileURLToPath } from 'node:url';
export default defineConfig(({mode}) => ({
  resolve: {
    alias: [{
      find: /^@material-symbols-svg\/react-rounded\/w700$/,
      replacement: fileURLToPath(new URL('./src/sdk/material-icons.mjs', import.meta.url)),
    }],
  },
  plugins: [react(), ...(mode === 'test' ? [] : [nodePolyfills({
    include: ['buffer','crypto','util','stream','events','process'],
    globals: {Buffer:true,global:true,process:true},
  })])],
  test: {server:{deps:{inline:[/@aurora-is-near\//,/@defuse-protocol\//]}}},
  server: {proxy:{'/api':'http://127.0.0.1:4318'}},
}));
