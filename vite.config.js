import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { offline } from './scripts/vite-plugin-offline.mjs'

// Icons that only lazy panels use (sound tools, tag editor, folder tree, album pages, playlist menu). The `icons` chunk is
// loaded at start-up, so these are left out of it and ride along with the panel that needs them. An icon missing from this
// list is harmless: it just joins the start-up chunk (the size budget, `npm run size`, is what notices).
const LAZY_ONLY_ICONS = [
  'accessibility', 'activity', 'audio-waveform', 'chevron-left', 'chevron-right', 'columns-2', 'copy', 'database-backup', 'download', 'folder',
  'gauge', 'hard-drive', 'image-plus', 'keyboard', 'list-end', 'list-start', 'locate-fixed', 'moon', 'orbit', 'palette', 'radio',
  'refresh-cw', 'shield-alert', 'shield-check', 'sliders-vertical', 'undo-2', 'waves',
]

// base './' keeps the build portable (static hosts, sub-paths, file shares) and the PWA scope relative.
export default defineConfig({
  base: './',
  // production build only: the Content-Security-Policy meta tag, and the offline service worker with the build's file list
  plugins: [react(), ...offline()],
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
    // wall time, which a runner cannot count any other way: a few heavy tests (loudness measurement, decoders) take three to
    // four times longer when coverage is being collected, and more again on a two-core CI runner that runs ninety files at once
    // (the time budgets inside the tests are in CPU time, see src/test-utils/fuzz.ts; this only catches a test that hangs)
    testTimeout: 30_000,
    // `npm run test:coverage`: what the unit tests execute. React components and the big hooks are exercised by the
    // Playwright suite instead (a different runner, not counted here), so the thresholds below guard the logic that has
    // no other safety net: every `src/lib` module, the build scripts and the desktop shell's helpers.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}', 'scripts/*.mjs', 'desktop/src/**/*.ts'],
      exclude: ['**/*.test.*', '**/*.d.ts', 'src/test-utils/**', 'src/main.tsx', 'desktop/src/main.ts', 'desktop/src/preload.ts'],
      thresholds: {
        // each group sits a little under what it reaches today: a drop fails the run, a rise is a reason to raise the number
        'src/lib/**': { statements: 77, branches: 75, functions: 76, lines: 77 },
        'scripts/*.mjs': { statements: 80, branches: 80, functions: 78, lines: 80 },
        'desktop/src/**': { statements: 90, branches: 88, functions: 82, lines: 90 },
        // the offline copy, storage and the parsers of untrusted input are held close to what they reach
        'src/lib/offline/{precache,protocol,updates,worker}.ts': { statements: 95, branches: 85, functions: 95, lines: 95 },
        'src/lib/{storage,lrc,backup,playlistfiles,search,id3write}.ts': { statements: 95, branches: 78, functions: 95, lines: 95 },
        // all files together, components and hooks included (Playwright covers those; this only keeps the figure from collapsing)
        statements: 52,
        branches: 53,
        functions: 41,
        lines: 52,
      },
    },
  },
})
