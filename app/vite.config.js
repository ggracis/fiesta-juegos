import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';

const pages = ['index', 'ticket', 'checkin', 'play', 'diag'];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, 'VITE_');
  const isPages = mode === 'pages'; // GitHub Pages: static demo data, repo sub-path
  return {
    root: 'src',
    envDir: '..',
    base: env.VITE_BASE || (isPages ? '/fiesta-juegos/' : '/'),
    define: isPages ?{ 'import.meta.env.VITE_DATA_MODE': JSON.stringify('static') } : undefined,
    publicDir: false,
    server: { proxy: { '/api': 'http://localhost:3000' } },
    build: {
      outDir: '../dist',
      emptyOutDir: true,
      rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, 'src', p + '.html')])) },
    },
  };
});
