import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'path';
import { writeFileSync, mkdirSync } from 'fs';

// Plugin to generate sidepanel.html at dist root after build
function generateSidepanelHtml() {
  return {
    name: 'generate-sidepanel-html',
    closeBundle() {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hanzi in Chrome</title>
  <link rel="stylesheet" href="./sidepanel.css">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="./sidepanel.js"></script>
</body>
</html>`;
      writeFileSync(resolve(__dirname, 'dist/sidepanel.html'), html);
      console.log('Generated dist/sidepanel.html');
    }
  };
}

export default defineConfig({
  plugins: [preact(), generateSidepanelHtml()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'src/sidepanel-preact/index.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
    minify: false,
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/sidepanel-preact'),
    },
  },
});
