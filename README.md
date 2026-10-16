# Wavelocal — a zero-ad, local-first MP3 player

![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-3-38bdf8?logo=tailwindcss&logoColor=white)
![Lucide](https://img.shields.io/badge/Icons-Lucide-f56565)
![Privacy](https://img.shields.io/badge/privacy-100%25%20local-22c55e)
![Ads](https://img.shields.io/badge/ads-none-a78bfa)

A modern dark-mode music player that runs entirely in your browser. Your files are read straight into memory — **no server, no uploads, no accounts, no tracking, no ads**.

## Features

- **Playback** — play/pause, next/previous, seek bar with live time and total duration
- **Volume** — slider with mute toggle
- **Modes** — shuffle, repeat all, repeat one
- **Load music** — drag & drop anywhere on the window (whole folders included), pick files, or pick a whole folder
- **Folder view** — the tree button in the library header browses by the folder structure you imported: keyboard-navigable (arrows, Home/End), searchable, remembers which folders are open, with *Play folder* and *Save as playlist* per folder
- **ID3 metadata** — title, artist, album and embedded cover art via `jsmediatags`; sleek procedural gradient artwork when a file has none
- **Smart playlists** — *Recently added*, *Most played*, *Recently played* and *Never played* sit in the library menu and fill themselves. A track counts as played once you have actually heard half of it or 30 seconds (pausing and seeking do not count, so skipping around cannot inflate it); counts and dates live only in your offline library on this device, can be cleared with one button, and a library from before this existed keeps working. A smart list is ordered when you open it and does not reshuffle under you while you listen.
- **Queue** — click to play, drag to reorder, remove tracks, live search by title/artist/album
- **OS integration** — Media Session API (media keys, lock-screen controls)
- **Responsive** — sidebar on desktop, slide-over queue on mobile

## Audiophile toolkit

- **DSP engine** — Web Audio graph: two playback decks → equalizer → bass/treble → compressor → stereo width → 3D spatial stage → reverb → limiter → analyser → master fade. Presets: Flat, Bass Boost, Vocal, Rock, Acoustic, Electronic, Treble Boost. Press `E` for the Sound & tools panel.
- **Equalizer** — the classic 10-band graphic EQ (31 Hz–16 kHz, ±12 dB, with presets) and a full **parametric** editor over the very same bands: drag handles on a live response curve to set frequency and gain, scroll to change Q, pick the filter type (peak, low/high shelf, notch), add up to 12 bands, and save/load your own curves. Each track can **remember its own EQ curve** (the rest keep the shared one). Everything is keyboard-operable; the drawn curve uses the same biquad maths as the audio engine (checked in tests against the browser's own `getFrequencyResponse`).
- **Dynamics & stereo** — a compressor (threshold, ratio, attack, release, knee, make-up) with a transfer-curve preview and live gain-reduction meter, a final limiter with an adjustable ceiling, a mid/side stereo widener (0–200 %) and a mono downmix, plus bass and treble shelves. Web Audio's compressor secretly adds its own make-up gain; the engine trims exactly that amount so the controls behave like a normal compressor and the limiter really limits.
- **Lossless fallback (WAV and FLAC)** — if a browser or WebView cannot play a WAV or FLAC file (no `canPlayType` support, an exotic WAV such as 64-bit float or RF64, or a native playback error), the file is decoded by a built-in pure-TypeScript decoder in a Web Worker and played as 16-bit PCM. FLAC support is complete (all subframe types, any block size, 4–24 bit, up to 8 channels, CRC and MD5 checks, damaged frames concealed); WAV covers 8/16/24/32-bit PCM, 32/64-bit float, A-law/µ-law, extensible and RF64. The decoder is loaded lazily, so it costs nothing unless it is needed.
- **3D spatial audio** — an HRTF `PannerNode` with a draggable (and keyboard-operable) position pad, distance and equal-power wet/dry controls, and an "8D" auto-rotate mode that circles the sound around your head at an adjustable speed. Best on headphones; off by default and costs nothing while off.
- **Reverb** — a `ConvolverNode` fed by procedurally generated impulse responses (small room, concert hall, cathedral, plate): each room has its own early reflections and tail colour, and the Decay control is the true RT60 (verified in tests by Schroeder integration). Pre-delay and an equal-power wet/dry mix; no impulse-response files are shipped or downloaded.
- **Visualizer** — live canvas spectrum bars or waveform on the Now Playing screen (click to switch).
- **Synced lyrics** — drop `Song.lrc` next to `Song.mp3` (matched by file name) or load one from the Lyrics tab; embedded ID3 lyrics are used too. Karaoke-style auto-scroll, tap a line to seek.
- **Offline library** — imported tracks, playlists, queue order, lyrics, settings and your last position are stored in IndexedDB, so a refresh or app restart keeps your music. Nothing leaves the device.
- **Playlists** — create from any track's `+` menu; reorder by drag; the library is separate from playlists.
- **Listen together** — Sound & tools → *Listen together* plays your music on several devices at once, in sync, over the same Wi-Fi. There is no server and no account: the devices connect directly (WebRTC) after you copy two short text codes between them (an *invite* from the host, a *reply* from the listener) by any means you like: a chat message, a note, reading it out. No STUN/TURN servers are configured, so nothing leaves your local network (and it does not work across the internet, by design). The host's play, pause, seek and track changes are followed by every listener; clocks are aligned with an NTP-style ping/pong, and a listener that drifts more than ~0.35 s is pulled back. A song a listener does not have is streamed from the host (only the current and next track, chunked with back-pressure and verified by byte count and CRC-32) and saved to their library like any import. The host can allow listeners to play/pause/skip. Up to 6 listeners. Needs a browser or WebView with WebRTC.
- **Sleep timer** — 15 / 30 / 45 / 60 min with a smooth 12-second fade-out.
- **Gapless & crossfade** — preloads the next track; crossfade blends over ~5 s.

## Runs everywhere

| Platform | Experience |
| --- | --- |
| **Phone** (iOS / Android) | Thumb-sized mini player, full-screen Now Playing (swipe down to minimize, swipe artwork for prev/next), bottom-sheet queue, safe-area padding, installable PWA |
| **Tablet / iPad** | Two-column split: queue + now playing, full transport bar |
| **Desktop** | Sidebar queue, centre stage, persistent controls, keyboard shortcuts |
| **Smart TV / big screen** | 10-foot UI: 1.5x scale, high contrast, thick focus rings, D-pad (arrow keys + Enter) navigation, remote media keys and Back |

- **PWA / offline** — web app manifest + service worker cache the app shell; install from the browser menu ("Add to Home Screen" / "Install"). Your audio is never cached or uploaded.
- **Media Session** — track title, artist and artwork on lock screens and notification shades; media keys, seek and background playback.
- **TV mode** — auto-enabled on Tizen / webOS / Android TV / Fire TV / console user agents. Force it with `?tv=1` (or `?tv=0`), or press `T`.

## Keyboard shortcuts

In TV mode arrow keys move focus (D-pad) instead of seeking; use the focused seek/volume slider with Left/Right, or the remote's media keys.


| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Seek −5s / +5s |
| `↑` / `↓` | Volume up / down |
| `Shift+←` / `Shift+→` (or `P` / `N`) | Previous / next track |
| `M` | Mute |
| `S` | Shuffle |
| `R` | Cycle repeat (off → all → one) |
| `/` | Focus search (`Esc` to leave) |
| `Alt+↑` / `Alt+↓` | Move the focused track up / down the queue (the keyboard alternative to dragging) |

## Accessibility

Wavelocal targets WCAG 2.2 AA and is checked automatically: `e2e/a11y.spec.ts` runs axe-core (WCAG 2.0 to 2.2 A/AA plus best practices) over the empty library, a playing track, both stage tabs, the folder view, the sound tools, the shortcut list, the tag editor and the phone sheets, and fails on any violation.

- **Screen readers** - landmarks and a skip-link pair (library, player controls), one polite live region that announces track changes, play/pause, search result counts and reorders, spoken slider values ("1 minute 5 seconds of 3 minutes 20 seconds"), labelled tab lists, radio groups and menus, and `aria-posinset`/`aria-setsize` on the virtualized track list.
- **Keyboard** - every dialog and sheet moves focus in, keeps Tab inside (the sound tools and shortcut list also make the page behind them `inert`) and returns focus to the control that opened it; tabs and radio groups use arrow keys / Home / End with a single tab stop; the add-to-playlist menu is arrow-key operable; reordering works without dragging (`Alt+↑`/`Alt+↓`).
- **Motion** - follows the system "reduce motion" setting, with a Motion override (follow device / reduce / full) in Sound & tools for WebViews that cannot see it. Reduced motion turns off animations, smooth scrolling and the live visualizer (a still frame is drawn).
- **Contrast** - secondary text meets 4.5:1 on every surface, and an accent colour that is too dark to read is lightened automatically while the text on filled accent buttons flips between black and white (`src/lib/contrast.ts`). `prefers-contrast: more` and Windows forced-colors mode have dedicated styles.

## Run locally

```bash
npm install && npm run dev
```

Production build: `npm run build` type-checks first, then bundles (output in `dist/`, deployable to any static host); preview with `npm run preview`.

### TypeScript

The whole app is TypeScript with `strict`, `noUncheckedIndexedAccess` and `noImplicitReturns` enabled (`tsconfig.json`, `noEmit`; Vite does the transpiling). Run `npm run typecheck` for a standalone check. `npm run build` runs it automatically, so a type error fails the build and the Android CI job. Shared domain types (`Track`, `Playlist`, `Lyrics`, `Settings`, `PlayerApi`) live in `src/types.ts`.

### Testing

| Command | What it runs |
| --- | --- |
| `npm test` | Vitest + jsdom unit tests (`src/**/*.test.ts`): LRC, loudness, metadata and ReplayGain, queue logic, contrast/focus/motion helpers, and the synthetic-audio tooling itself |
| `npm run test:e2e` | Builds the app, then runs the Playwright suite headlessly in Chromium (`e2e/`): import, playback, seek, queue reorder, search, playlists, persistence across reloads, lyrics sync, EQ, speed, normalization, sleep timer and gapless/crossfade transitions |

First-time e2e setup: `npx playwright install chromium`. No audio files are committed: every test generates synthetic WAV/ID3 data in code (`src/test-utils/`), including sine, sweep, silence, clipped and different-loudness fixtures, plus a small FLAC encoder used to build FLAC fixtures. The JavaScript FLAC decoder is also checked sample-for-sample against the browser's native decoder. The e2e tests also inspect the real Web Audio graph (filter gains, normalization gain nodes, crossfade overlap) rather than only the DOM.

CI (`.github/workflows/ci.yml`) runs the typecheck, unit tests and e2e suite on every push and pull request, separately from the APK build. Playwright browsers are cached by version, and a failed e2e run uploads its traces, screenshots and HTML report as a build artifact.

### Desktop app (Electron)

`desktop/` is a separate npm project (the web app never imports from it). The shell serves the built web app from a private `app://wavelocal/` origin (so module workers and IndexedDB persistence work), runs sandboxed with context isolation, attaches a strict Content-Security-Policy, cancels every request that is not local, and denies navigation, new windows and permission prompts. Your audio never leaves the machine.

```bash
npm run desktop:install   # once: installs Electron and TypeScript in desktop/
npm run desktop:dev       # Vite dev server + Electron
npm run build && npm run desktop:start   # run the built app
npm run desktop:test      # Electron smoke tests (needs a fresh `npm run build`)
```

The shell adds a **system tray**: a now-playing tooltip, and a menu with play/pause, next, previous, show/hide, *Close to tray* (on by default; closing or minimizing the window then keeps the music playing in the tray) and quit. The page talks to it through a small typed bridge (`window.wavelocalDesktop.tray`) whose messages are validated on both sides.

**Global media hotkeys** work even while the window is hidden: the media keys (play/pause, next, previous) are bound by default, and volume up/down and mute can be bound in *Sound & tools → Global hotkeys* by pressing the key combination you want. Shortcuts that would interfere with typing or belong to the system (for example `Ctrl+C`) are refused, as are duplicates and shortcuts another application already owns; a refused change keeps the previous shortcut.

**Windows installer.** `npm run desktop:dist` builds `desktop/release/Wavelocal-Setup-<version>-x64.exe` with electron-builder (an NSIS installer: per-user install, choose the folder, desktop and Start-menu shortcuts, no admin rights needed) and then verifies it: the installer exists, the web build is bundled under `resources/web`, and the asar holds the compiled shell without tests or source maps. `npm run desktop:pack` makes only the unpacked app (faster; it is what the packaged-app smoke test in `desktop/e2e/packaged.spec.ts` launches). The config is `desktop/electron-builder.config.cjs`, and `.github/workflows/desktop-installer.yml` runs the whole thing on `windows-latest`, smoke-tests the packaged app and uploads the installer as a build artifact (on `v*` tags it is also attached to the draft release). The installer is **unsigned**, so Windows SmartScreen warns on first run; the app has no auto-updater and never touches the network.

The page can detect the shell through `getDesktopBridge()` (`src/desktop-bridge.ts`); it is `null` in browsers and on Android.

## Architecture

```
src/
├── main.tsx              entry point
├── App.tsx               layout, window-wide drag & drop, file/folder inputs
├── hooks/
│   ├── usePlayer.ts      queue, playlists, persistence, sleep timer, crossfade, Media Session
│   ├── useHotkeys.ts     global keyboard / remote shortcuts
│   ├── useTvMode.ts      10-foot UI + D-pad focus navigation
│   └── useSwipe.ts       touch gestures
├── lib/
│   ├── engine.ts         Web Audio graph: decks, 10-band EQ, spatial stage, analyser, fades
│   ├── spatial.ts        pure 3D audio geometry (pad → position, orbit curves, wet/dry law)
│   ├── eq.ts             band model, biquad maths, response curve, custom presets
│   ├── dynamics.ts       compressor / limiter / stereo-width / tone model and maths
│   ├── audio/            WAV + FLAC decoders, PCM16 encoder, container sniffing, worker, playable-URL resolver
│   ├── reverb.ts         procedural room impulse responses + reverb settings
│   ├── dsp.ts            shared numeric helpers (clamp, seeded RNG, equal-power mix)
│   ├── lrc.ts            LRC parser + active-line lookup
│   ├── db.ts             IndexedDB wrapper (tracks + meta)
│   ├── plays.ts          what counts as a play (listening-time tally)
│   ├── smart.ts          smart playlists (recent / most played / recently played / never played)
│   ├── share/            listen together: pairing codes, wire protocol, clock sync, drift planning, file streaming, WebRTC peer (lazy chunk)
│   ├── metadata.ts       File → track (ID3 tags, cover art, lyrics pairing)
│   └── format.ts         time formatting, procedural fallback artwork
├── types.ts              shared domain types (Track, Playlist, Lyrics, PlayerApi, …)
└── components/
    ├── Playlist.tsx      queue sidebar, search, drag-to-reorder
    ├── NowPlaying.tsx    center stage: artwork, title, empty state
    ├── PlayerBar.tsx     persistent transport + seek + volume
    ├── Slider.tsx        styled range input
    └── Cover.tsx         embedded or generated artwork
```

State lives in a single `usePlayer` hook. Tracks are held as object URLs created from the `File` objects you choose; they are revoked when removed. Nothing is persisted or sent anywhere.

## Privacy

There are no network calls beyond loading the app itself. Listening together talks only to the device you pair with, directly over your local network (no signalling or STUN servers). Close the tab and your library is gone from memory.

## License

MIT
