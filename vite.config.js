import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

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
            { name: 'icons', test: /node_modules[\/]lucide-react[\/]/, priority: 10 },
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
