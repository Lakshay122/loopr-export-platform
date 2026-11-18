import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The UI only talks to the backend API. In dev, Vite forwards /api and /internal to it,
// so the browser sees one origin and no CORS setup is needed.
const apiUrl = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': apiUrl, '/internal': apiUrl },
  },
});
