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
- **Load music** — drag & drop anywhere on the window, pick files, or pick a whole folder
- **ID3 metadata** — title, artist, album and embedded cover art via `jsmediatags`; sleek procedural gradient artwork when a file has none
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
| `npm test` | Vitest + jsdom unit tests (`src/**/*.test.ts`): LRC, loudness, metadata and ReplayGain, queue logic, and the synthetic-audio tooling itself |
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

There are no network calls beyond loading the app itself. Close the tab and your library is gone from memory.

## License

MIT
