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

Production build: `npm run build` (output in `dist/`, deployable to any static host), preview with `npm run preview`.

## Architecture

```
src/
├── main.jsx              entry point
├── App.jsx               layout, window-wide drag & drop, file/folder inputs
├── hooks/
│   ├── usePlayer.js      owns the <audio> element + queue/playback state, Media Session
│   └── useHotkeys.js     global keyboard shortcuts
├── lib/
│   ├── metadata.js       File → track (ID3 tags, cover art Blob URLs)
│   └── format.js         time formatting, procedural fallback artwork
└── components/
    ├── Playlist.jsx      queue sidebar, search, drag-to-reorder
    ├── NowPlaying.jsx    center stage: artwork, title, empty state
    ├── PlayerBar.jsx     persistent transport + seek + volume
    ├── Slider.jsx        styled range input
    └── Cover.jsx         embedded or generated artwork
```

State lives in a single `usePlayer` hook. Tracks are held as object URLs created from the `File` objects you choose; they are revoked when removed. Nothing is persisted or sent anywhere.

## Privacy

There are no network calls beyond loading the app itself. Close the tab and your library is gone from memory.

## License

MIT
