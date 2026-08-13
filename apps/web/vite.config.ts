import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    // L'API tourne à côté en développement. Le mandataire évite d'avoir à
    // gérer les en-têtes CORS pour un cas qui n'existe pas en production, où
    // les deux sont servis depuis le même domaine.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (chemin) => chemin.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    // Le bundle est aussi embarqué tel quel par l'application desktop : pas de
    // chemin absolu qui supposerait un serveur à la racine d'un domaine.
    target: 'es2022',
    sourcemap: true,
  },
});
