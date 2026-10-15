import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { getDesktopBridge } from './desktop-bridge'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Missing #root element')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Offline-capable PWA: cache the app shell (production builds only). The desktop shell already ships the app on disk,
// so it skips the service worker rather than keep a second copy of the app in a cache.
if ('serviceWorker' in navigator && import.meta.env.PROD && !getDesktopBridge()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {})
  })
}
