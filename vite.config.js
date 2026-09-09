import { defineConfig } from 'vite';
import { resolve } from 'path';
import { existsSync } from 'fs';
import react from '@vitejs/plugin-react';

const __dirname = new URL('.', import.meta.url).pathname;

// Mirrors Vercel's `cleanUrls` in dev: lets pages link to `/login` instead of
// `/login.html` and still resolve locally, so no URL ever needs to show .html.
function cleanUrlsDev() {
  return {
    name: 'clean-urls-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const [pathname, search = ''] = req.url.split('?');
        if (pathname.includes('.') || pathname.startsWith('/@') || pathname.startsWith('/node_modules/')) {
          return next();
        }
        const htmlPath = resolve(__dirname, `.${pathname}.html`);
        if (existsSync(htmlPath)) {
          req.url = `${pathname}.html${search ? `?${search}` : ''}`;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), cleanUrlsDev()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        login: resolve(__dirname, 'login.html'),
        signup: resolve(__dirname, 'signup.html'),
        'reset-password-request': resolve(__dirname, 'reset-password-request.html'),
        'reset-password': resolve(__dirname, 'reset-password.html'),
        project: resolve(__dirname, 'project.html'),
        profile: resolve(__dirname, 'profile.html'),
        'browse-flags': resolve(__dirname, 'browse-flags.html'),
flags: resolve(__dirname, 'flags.html'),
        'flags-variations': resolve(__dirname, 'flags-variations.html'),
        'flags-gallery': resolve(__dirname, 'flags-gallery.html'),
        'hole-signs': resolve(__dirname, 'hole-signs.html'),
        submitted: resolve(__dirname, 'submitted.html'),
        'event-info': resolve(__dirname, 'event-info.html'),
        review: resolve(__dirname, 'review.html'),
        order: resolve(__dirname, 'order.html'),
      },
    },
  },
});
