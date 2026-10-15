import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// base './' keeps the build portable (static hosts, sub-paths, file shares) and the PWA scope relative.
export default defineConfig({
  base: './',
  plugins: [react()],
  // the lossless-decoder worker is loaded as an ES module (supported by every browser and WebView this app targets)
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
})
