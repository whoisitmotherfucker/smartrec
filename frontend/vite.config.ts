import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Output directly into the backend's public folder so Express can serve it
    outDir: '../backend/public',
    emptyOutDir: true,
  },
});
