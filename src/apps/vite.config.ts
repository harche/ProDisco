import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'path';

export default defineConfig({
  plugins: [viteSingleFile()],
  root: path.resolve(__dirname, 'runSandbox'),
  build: {
    outDir: path.resolve(__dirname, '../../dist/apps/runSandbox'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
