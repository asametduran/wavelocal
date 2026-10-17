import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Icons that only lazy panels use (sound tools, tag editor, folder tree, album pages, playlist menu). The `icons` chunk is
// loaded at start-up, so these are left out of it and ride along with the panel that needs them. An icon missing from this
// list is harmless: it just joins the start-up chunk (the size budget, `npm run size`, is what notices).
const LAZY_ONLY_ICONS = [
  'accessibility', 'activity', 'chevron-left', 'chevron-right', 'columns-2', 'copy', 'database-backup', 'download', 'folder',
  'gauge', 'image-plus', 'keyboard', 'list-end', 'list-start', 'locate-fixed', 'moon', 'orbit', 'palette', 'radio',
  'sliders-vertical', 'undo-2', 'waves',
]

// base './' keeps the build portable (static hosts, sub-paths, file shares) and the PWA scope relative.
export default defineConfig({
  base: './',
  plugins: [react()],
  // the lossless-decoder worker is loaded as an ES module (supported by every browser and WebView this app targets)
  worker: { format: 'es' },
  build: {
    // app code changes every release; React and the icon set almost never do, so they get their own long-lived chunks
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\/](react|react-dom|scheduler)[\/]/, priority: 20 },
            { name: 'icons', test: new RegExp(`node_modules[\\\\/]lucide-react[\\\\/](?!.*[\\\\/](?:${LAZY_ONLY_ICONS.join('|')})\\.mjs$)`), priority: 10 },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    // the desktop shell's pure helpers (no Electron imports) are tested here too
    include: ['src/**/*.test.{ts,tsx}', 'desktop/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    restoreMocks: true,
  },
})
