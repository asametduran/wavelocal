import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import RootBoundary from './components/RootBoundary'
import { installCapture, note } from './lib/diagnostics/capture'

installCapture() // errors nobody caught and promises nobody handled are kept in the error log (Sound & tools, Diagnostics)

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Missing #root element')

createRoot(rootEl).render(
  <StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
  </StrictMode>,
)

// Offline copy and updates, and the Android app's own parts: after the page has loaded, off the start-up path. Whether this
// window gets a service worker at all (production web only, not the desktop shell or the Android app, which already hold the
// app) is decided in there.
window.addEventListener('load', () => {
  import('./lib/afterload').then((m) => m.afterLoad()).catch(note('worker'))
})
