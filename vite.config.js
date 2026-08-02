import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The /api proxy is gone along with the Express server it pointed at. There is
// no application backend to run locally any more: the enforcement layer is the
// database, and the gateway is a deployed edge function.
export default defineConfig({
  plugins: [react()],
  server: { port: 3000 },
});
