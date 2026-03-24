import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: '/dashboard/',
  esbuild: {
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
    jsxInject: `import { h, Fragment } from 'preact'`,
  },
  build: {
    outDir: resolve(__dirname, '../dist/dashboard'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      'react': 'preact/compat',
      'react-dom': 'preact/compat',
    },
  },
});
