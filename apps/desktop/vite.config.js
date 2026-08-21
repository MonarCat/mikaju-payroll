import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Electron loads the renderer over file:// in production, so paths must be
// relative — 'base: ./' is what makes that work.
export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react()],
  envDir: '../..', // read the same repo-root .env that main.js loads (path.join(__dirname, '../../.env'))
  envPrefix: ['VITE_', 'MIKAJU_'], // expose MIKAJU_* vars to import.meta.env too
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
