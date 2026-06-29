import { defineConfig } from 'vite';
import { resolve } from 'path';
import react from '@vitejs/plugin-react';

const __dirname = new URL('.', import.meta.url).pathname;

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        login: resolve(__dirname, 'login.html'),
        project: resolve(__dirname, 'project.html'),
flags: resolve(__dirname, 'flags.html'),
        'flags-variations': resolve(__dirname, 'flags-variations.html'),
        'flags-gallery': resolve(__dirname, 'flags-gallery.html'),
        'hole-signs': resolve(__dirname, 'hole-signs.html'),
        review: resolve(__dirname, 'review.html'),
        order: resolve(__dirname, 'order.html'),
      },
    },
  },
});
