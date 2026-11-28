import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      // The chrome window, the presence overlay window (#233), and the Motion Lab (#234).
      input: {
        index: path.resolve(__dirname, 'src/renderer/index.html'),
        presence: path.resolve(__dirname, 'src/renderer/presence.html'),
        lab: path.resolve(__dirname, 'src/renderer/lab.html')
      }
    }
  }
});
