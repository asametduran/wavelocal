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

- **DSP engine** — Web Audio graph: two playback decks → 10-band equalizer (31 Hz–16 kHz, ±12 dB) → analyser → master fade. Presets: Flat, Bass Boost, Vocal, Rock, Acoustic, Electronic, Treble Boost. Press `E` for the Sound & tools panel.
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

First-time e2e setup: `npx playwright install chromium`. No audio files are committed: every test generates synthetic WAV/ID3 data in code (`src/test-utils/`), including sine, sweep, silence, clipped and different-loudness fixtures. The e2e tests also inspect the real Web Audio graph (filter gains, normalization gain nodes, crossfade overlap) rather than only the DOM.

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
│   ├── engine.ts         Web Audio graph: decks, 10-band EQ, analyser, fades
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
