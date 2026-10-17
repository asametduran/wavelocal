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
- **Folders** — the *Folders* tab browses by the folder structure you imported: keyboard-navigable (arrows, Home/End), searchable, remembers which folders are open, with *Play folder* and *Save as playlist* per folder
- **File details** — importing reads the *headers* of every file in pure TypeScript (nothing is decoded): MP3 (Xing/Info/VBRI frame counts and the LAME encoder delay, or a walk over every frame for a variable-bitrate file that has no header), MP4/M4A (AAC and Apple Lossless; the track's edit list for the playable length, the sample table for the true bitrate), Ogg Vorbis and Opus, FLAC, WAV/RF64 and raw ADTS AAC. Every track therefore has its real length at once (the library header shows the total), the Now Playing screen shows what the file is (`FLAC · 96 kHz · 24-bit`, a Hi-Res mark above CD quality, `MP3 · 193 kbps VBR`), and the tags `jsmediatags` cannot read come through too: Ogg, FLAC and WAV tags and artwork, album artist, track and disc numbers, year, genre (numeric ID3 genres such as `(13)` become names) and the compilation flag. The probes were checked against `ffprobe`, `mutagen` and Chromium on well over a hundred really encoded files, and a seeded fuzz test feeds them damaged ones. Anything no probe understands falls back to asking the browser for the length.
- **Scalable import** — files are read a few at a time (never thousands at once); tracks appear and are saved in batches of 100 while the rest is still being read; a progress pill counts the files and has a *Cancel* button (what was read stays); imports started together queue up and never add a file twice; a folder imports folder by folder, in natural file order.
- **Upgrades itself** — a library stored by an earlier version is brought up to date quietly in the background, from the audio copies it already holds (lengths, track numbers, formats, genres...): a few files at a time, the progress kept in the records so a restart carries on, only unknown fields filled in (a loudness you measured or a value you set is never overwritten), and nothing re-imported or rewritten.
- **ID3 metadata** — title, artist, album and embedded cover art via `jsmediatags`; sleek procedural gradient artwork when a file has none
- **Smart playlists** — *Recently added*, *Most played*, *Recently played* and *Never played* sit in the library menu and fill themselves. A track counts as played once you have actually heard half of it or 30 seconds (pausing and seeking do not count, so skipping around cannot inflate it); counts and dates live only in your offline library on this device, can be cleared with one button, and a library from before this existed keeps working. A smart list is ordered when you open it and does not reshuffle under you while you listen.
- **Backup & restore** — Sound & tools → *Backup & restore* exports your playlists, tags, lyrics, play counts, added dates and per-track EQ curves to one JSON file (no audio, no artwork) and restores from one. Restoring is a merge that shows a preview first and never removes anything: matching tracks (same name, size and modified time as the library key) get their tags, lyrics and counters back (counts only ever go up), playlists are merged by id or name, and anything that refers to files you do not have yet is remembered and fills in automatically as those files are added, even after a restart. The file is untrusted input: size-capped, validated field by field, damaged entries skipped and reported.
- **Search** — forgiving and fast: accents, capitals and the Turkish dotted/dotless i do not matter (`istanbul` finds `İstanbul`, `yarisi` finds `Yarısı`, `beyonce` finds `Beyoncé`), every word has to match in any order, and a few filters narrow it down: `artist:`, `album:`, `title:`, `genre:`, `year:` (`1965`, `1990..1999`, `>=2000`, `1990s`), `folder:` and `file:`, `"exact phrases"` and `-excluded` words. The `?` button next to the box lists them, and its examples add themselves to the search. The same search works in the track list, the albums and artists, and the folder tree.
- **Sort** — a sort menu above the list: title, artist, album, track number, length, date added, play count and year, ascending or descending (named in words: *A to Z*, *newest first*), remembered. Text sorts the way your language sorts it (accents and case do not matter, "Track 2" comes before "Track 10"), unknown values (no year, no album) always go last, and ties fall back to a natural order (an artist's albums stay together, an album stays in disc and track order). Next and previous follow the sorted order, rows say why they are where they are ("2019", "added 3 days ago"), and dragging is only offered in the stored order.
- **Albums and artists** — the *Albums* and *Artists* tabs group the list on screen (the library, a playlist or a smart list) by the tags: covers, titles, years and totals in a virtualized grid that stays smooth with thousands of albums; compilations stay together under *Various Artists*, tracks with no album tag gather on one *Unknown album*. An album opens as a page with its tracks in disc and track order (a heading per disc), an artist as a page with their albums oldest first; each has *Play*, *Shuffle* and *Add to playlist* for the whole thing, and a card or row plays without opening. Playing from a page keeps playing from that page while you browse on (the album does not change under you when you look at another one); playing a track from the track list goes back to following that list. Arrow keys, Home/End and PageUp/PageDown move between cards, Back, `Esc` and a phone's Back button close a page, and the panel widens for browsing on tablets and desktops.
- **Queue** — click to play, drag to reorder (in the stored order), remove tracks, live search
- **Up Next** — *Play next* and *Add to queue* on every track's `+` menu and on every album and artist page put tracks in a queue that plays before the list carries on: the latest *Play next* plays first, a track can be queued twice, and the list then carries on after the track the queue interrupted (not after the queued one). The *Up Next* tab beside Artwork and Lyrics lists it with a count: play a track now, move it (arrow buttons, `Alt+↑`/`Alt+↓` or dragging), take it out, or clear it, each with an *Undo*. It is saved with the library and survives a restart, tracks that leave the library leave the queue, shuffle and gapless/crossfade respect it, and a queued track that is still being decoded when its turn comes is waited for rather than dropped.
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
- **Playlists** — create from any track's `+` menu or from an album or artist page; reorder by drag; the library is separate from playlists. The `…` menu of an open playlist renames it, duplicates it (right after the original, "… copy"), saves it as a file, or deletes it; a deleted playlist can be brought back, with its place in the list and the tracks the library still has, and is opened again if it was open.
- **Playlist files** — pick or drop an `.m3u`, `.m3u8` or `.pls` file (alone, or together with the music it names: the music goes in first) and it becomes a playlist; save any playlist as M3U8 or PLS to use it elsewhere. A playlist file is untrusted text from another player or another system, so reading is forgiving about how it is written and strict about what comes out: UTF-8, UTF-16 or Windows-1252, either line ending, `#EXTINF` titles and lengths, `file://` URLs and percent-encoding, Windows and Unix paths, and quoted paths; tracks are found by path, then by file name (the folders decide between files of the same name), then by name with another extension, and finally by the title and artist the file gives, which is only trusted when exactly one track fits. Tracks the library does not have are listed in a dialog, internet streams are skipped and said so, and two files with the same name never overwrite each other.
- **Dialogs, toasts and undo** — nothing in the app uses the browser's own `prompt` and `confirm` boxes (the desktop shell has no `prompt` at all): questions are in-app dialogs that trap focus, make the page behind them inert, start on *Cancel* when the answer destroys something, and close with `Esc`, a click outside, a remote's Back key or a phone's Back button, which leaves a sheet under them open. Changes that can be taken back (deleting or duplicating a playlist, queueing, removing from or clearing the queue) say so in a toast with an *Undo*, and `Ctrl+Z` takes back the latest one.
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

- **PWA / offline** — the whole app is saved on the first visit, so it opens with no connection, and updates wait until you choose to reload ([details](#offline-use-updates-and-storage)); install from the browser menu ("Add to Home Screen" / "Install"). Your audio is never cached by the service worker or uploaded.
- **Media Session** — track title, artist and artwork on lock screens and notification shades; media keys, seek and background playback.
- **TV mode** — auto-enabled on Tizen / webOS / Android TV / Fire TV / console user agents. Force it with `?tv=1` (or `?tv=0`), or press `T`.

## Offline use, updates and storage

The web app saves a complete, versioned copy of itself the first time it is opened, so it starts with no connection at all, with every panel and the lossless decoder included.

- **Checked, versioned and lean.** Every build has its own cache (`wavelocal-precache-<build id>`). The service worker downloads each file, checks its size and SHA-256 against the list compiled into it at build time, and only then marks the copy complete. A damaged download (a hotel Wi-Fi sign-in page answering `200`, a truncated file) fails the install and the working copy stays. A release that changes three files downloads three files; the rest is copied from the copy already on the device.
- **Updates ask first.** A new version downloads in the background and waits. A toast (and a button under *Sound & tools → Storage*) offers **Reload**; nothing is swapped behind your back, so music is never interrupted by an update. When the new copy takes over, the old one is deleted (and the leftovers of the retired v1 worker); other sites' and apps' caches are never touched. A second window that was open meanwhile is told, and can follow.
- **Self-healing.** If the browser clears the cache, the worker fetches the app again and stores it for next time.
- **Only where it helps.** In the desktop app and the Android app the app already lives on the device, so neither registers a worker; the Android app also removes any worker that earlier versions registered, so none can serve an old copy.

**Storage** (*Sound & tools → Storage*): the audio you add is copied into the browser's own database, so the library costs its size again. The panel shows what is used out of what the device allows (and how much of it is your music, the app's offline files, and anything else), warns when room is running out, and says whether the browser may delete the library when the device runs low on space, with a button to ask it to keep it (a backup keeps playlists and tags safe either way). It lists the largest tracks, each with a *Remove* that asks first. Adding files that would not fit asks before it starts, a save that fails because the device is full says so (and stops reading the rest), and after an import a warning appears once when storage is getting full.

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
| `/` | Focus search (`Esc` clears it, then leaves it) |
| `Alt+↑` / `Alt+↓` | Move the focused track up / down the queue or the Up Next list (the keyboard alternative to dragging) |
| `Ctrl+Z` | Undo the latest playlist or queue change (the toast's *Undo*); a text field keeps its own undo |
| Arrows, `Home`, `End`, `PageUp`, `PageDown` | Move between the albums or artists (one card is in the Tab order; `Enter` opens it) |
| `Esc` | Close the top panel or question, or go back from an album or artist page |

## Accessibility

Wavelocal targets WCAG 2.2 AA and is checked automatically: `e2e/a11y.spec.ts` runs axe-core (WCAG 2.0 to 2.2 A/AA plus best practices) over the empty library, a playing track, both stage tabs, the folder view, the sound tools, the shortcut list, the tag editor and the phone sheets, and fails on any violation.

- **Screen readers** - landmarks and a skip-link pair (library, player controls), one polite live region that announces track changes, play/pause, search result counts (tracks, albums or artists), sort changes ("Sorted by Title, A to Z") and reorders, an album or artist page that moves focus to its title, spoken slider values ("1 minute 5 seconds of 3 minutes 20 seconds"), labelled tab lists, radio groups and menus, and `aria-posinset`/`aria-setsize` on the virtualized track list.
- **Keyboard** - every dialog and sheet moves focus in, keeps Tab inside (the sound tools and shortcut list also make the page behind them `inert`) and returns focus to the control that opened it; tabs and radio groups use arrow keys / Home / End with a single tab stop; the add-to-playlist and playlist menus are arrow-key operable; reordering works without dragging (`Alt+↑`/`Alt+↓`). Questions are labelled dialogs (`alertdialog` when the answer destroys something) whose first focus is the safe choice, toasts are polite status messages that wait while the pointer or focus is on them, and a phone's Back button or a remote's Back key answers a question with "no" instead of leaving the app or closing the sheet under it.
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
| `npm test` | Vitest + jsdom unit tests (`src/**/*.test.ts`, `scripts/`, `desktop/src/`): LRC, loudness, metadata and ReplayGain, queue logic, contrast/focus/motion helpers, the offline service worker, storage, the build scripts, the Android manifest, and the synthetic-audio tooling itself |
| `npm run test:coverage` | The same, with V8 coverage and thresholds (`coverage` in `vite.config.js`): the pure logic in `src/lib`, the build scripts and the desktop helpers must stay above their floors, and the offline layer, storage and the parsers of untrusted input are held near 95%. CI runs this instead of `npm test` and keeps the report as an artifact. Components and the player hook are covered by the e2e suite, which is not counted here |
| `npm run test:e2e` | Builds the app, then runs the Playwright suite headlessly in Chromium (`e2e/`): import, playback, seek, queue reorder, search, playlists, persistence across reloads, lyrics sync, EQ, speed, normalization, sleep timer and gapless/crossfade transitions; plus, with a real service worker against a server the tests can switch off, replace and sabotage, `offline.spec.ts` (offline reload, panels and decoder never opened online, updates, damaged releases, the upgrade from the retired worker) and `csp.spec.ts` (the policy is enforced and the app never breaks it) |
| `npm run check:dist` | Holds the finished build to its promises (also the last step of `npm run build`): the page carries the Content-Security-Policy, every emitted file type is one the policy lets a page load, `sw.js` is a classic script carrying this build's id, and everything the page and its chunks refer to is part of the offline copy |

**Fuzzing.** The parsers of untrusted input (LRC, backup JSON, the ID3 rewriter, M3U/PLS and their matching, pairing codes, WAV and FLAC, the search query, and the desktop shell's path and shortcut validators) each have a `*.fuzz.test.ts` that feeds them random and damaged input from a seeded generator (`src/test-utils/fuzz.ts`) and checks what must hold for any input: no throw but their own typed error, well-formed bounded output, no prototype pollution, and a time budget on pathological input (counted in CPU time, not wall time, so a busy laptop or a two-core CI runner cannot fail it). A failing case is replayed by its seed. `FUZZ_RUNS=15 npm test` runs 15 times as many cases and `FUZZ_SEED=1000` shifts the seeds, for a longer session.

First-time e2e setup: `npx playwright install chromium`. No audio files are committed: every test generates synthetic WAV/ID3 data in code (`src/test-utils/`), including sine, sweep, silence, clipped and different-loudness fixtures, plus a small FLAC encoder used to build FLAC fixtures. The JavaScript FLAC decoder is also checked sample-for-sample against the browser's native decoder. The e2e tests also inspect the real Web Audio graph (filter gains, normalization gain nodes, crossfade overlap) rather than only the DOM.

CI (`.github/workflows/ci.yml`) runs the typecheck, the unit tests with coverage thresholds and the e2e suite on every push and pull request, separately from the APK build. Playwright browsers are cached by version, and a failed e2e run uploads its traces, screenshots and HTML report as a build artifact.

### Security of the build

- **Content-Security-Policy.** `vite build` writes a `<meta>` policy (`scripts/csp.mjs`) straight after the charset of `index.html`: everything starts closed (`default-src 'none'`) and only what the app uses is opened, namely its own scripts, styles, worker and manifest, and `blob:` for audio and cover art. No remote host, no inline script, no `eval`, no `unsafe-inline` (inline styles are set through the CSSOM, which CSP does not restrict). `connect-src 'self'` means even a bug could not send data anywhere. `npm run check:dist` fails the build if a new kind of file is emitted that nobody decided about (a font, WebAssembly). A host should additionally send `frame-ancestors 'none'` and serve the files unmodified (the service worker verifies their checksums, so a proxy that rewrites HTML or scripts stops the offline copy from installing).
- **Android.** `android:allowBackup="false"` plus `data_extraction_rules.xml` keep the library (the WebView's database) out of cloud backups and device transfers; `usesCleartextTraffic="false"` and a network security config refuse plain HTTP and user-installed certificates; the only permission is `INTERNET` (needed by listening together). `scripts/android-manifest.test.ts` pins all of it, since the APK cannot be built on every machine.
- **Service worker.** `sw/sw.ts` is bundled by `scripts/precache.mjs` after every build with the build's file list (size, SHA-256, content type) compiled in; the build id is derived from that list, so identical sources give an identical worker and nobody is asked to update for nothing. The logic is in `src/lib/offline/` and is tested without a browser against an in-memory cache and a scripted network.

### Desktop app (Electron)

`desktop/` is a separate npm project (the web app never imports from it). The shell serves the built web app from a private `app://wavelocal/` origin (so module workers and IndexedDB persistence work), runs sandboxed with context isolation, attaches a strict Content-Security-Policy, cancels every request that is not local, and denies navigation, new windows and permission prompts. Your audio never leaves the machine.

```bash
npm run desktop:install   # once: installs Electron and TypeScript in desktop/
npm run desktop:dev       # Vite dev server + Electron
npm run build && npm run desktop:start   # run the built app
npm run desktop:test      # Electron smoke tests: window, tray, hotkeys, in-app dialogs (builds first)
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
│   ├── usePlayer.ts      queue, sort, "playing from" context, playlists, persistence, sleep timer, crossfade, Media Session
│   ├── useBrowse.ts      the library panel's mode and open album/artist pages, mirrored in the browser history so Back closes a page
│   ├── useRemScale.ts    root font size as a scale, so virtualized rows grow with TV mode and large text
│   ├── useHotkeys.ts     global keyboard / remote shortcuts
│   ├── useTvMode.ts      10-foot UI + D-pad focus navigation
│   └── useSwipe.ts       touch gestures
├── lib/
│   ├── engine.ts         Web Audio graph: decks, 10-band EQ, spatial stage, analyser, fades
│   ├── spatial.ts        pure 3D audio geometry (pad → position, orbit curves, wet/dry law)
│   ├── eq.ts             band model, biquad maths, response curve, custom presets
│   ├── dynamics.ts       compressor / limiter / stereo-width / tone model and maths
│   ├── audio/            WAV + FLAC decoders, PCM16 encoder, container sniffing, worker, playable-URL resolver
│   │   ├── probe/        header-only container probes (MP3, MP4, Ogg, FLAC, WAV, ADTS) + ID3 text frames: duration, format, tags
│   │   ├── source.ts     seekable byte source (read a few headers of a file, never all of it) + integer readers
│   │   └── vorbis.ts     Vorbis comments and FLAC pictures (tags of FLAC, Ogg and Opus)
│   ├── importer.ts       the import pipeline: bounded concurrency, batches, progress, cancel, ordering, de-duplication
│   ├── analyze.ts        one pass over a file: probe + tag readers → tags, details, duration, cover, ReplayGain
│   ├── upgrade.ts        background upgrade of libraries stored before the details were read
│   ├── tagfields.ts      track/disc numbers, year, genre names and the other fields tags are turned into
│   ├── trackmeta.ts      the analysis fields of a library record: defaults, repair, analysis version
│   ├── pool.ts           bounded-concurrency work queue (order kept, failures isolated, abortable)
│   ├── reverb.ts         procedural room impulse responses + reverb settings
│   ├── dsp.ts            shared numeric helpers (clamp, seeded RNG, equal-power mix)
│   ├── lrc.ts            LRC parser + active-line lookup
│   ├── db.ts             IndexedDB wrapper (tracks + meta)
│   ├── storage.ts        usage, quota, persistence, biggest tracks, import-fits check and the words for "storage is full" (lazy chunk)
│   ├── offline/          the offline copy: cache naming and routing, install planning, the worker core (injected caches), the page's update controller (lazy chunk)
│   ├── backup.ts         library backup/restore: export, validation, merge, pending restore
│   ├── plays.ts          what counts as a play (listening-time tally)
│   ├── smart.ts          smart playlists (recent / most played / recently played / never played)
│   ├── search.ts         accent- and Turkish-aware tokenized search, `artist:`/`year:` filters, per-track folded index
│   ├── sort.ts           locale-aware stable sorting with unknowns last, sort menu keys and their wording
│   ├── groups.ts         albums and artists from tags (compilations, unknown album), their sorting, search and the shared index
│   ├── pages.ts          rows and labels of the album and artist pages (disc headings, an album per heading)
│   ├── browse.ts         browse modes and the trail of open pages (what Back does)
│   ├── grid.ts           layout maths of the virtualized grid: columns, visible rows, arrow-key targets
│   ├── view.ts           the tracks a list shows (the library or a playlist, sorted) and why a row is where it is
│   ├── upnext.ts         the Up Next queue as pure functions on track ids: play next, add, take, move, undo, where the list carries on
│   ├── queueactions.ts, queuemessages.ts   what "Play next" / "Add to queue" / "Clear" do for the listener and say in a toast
│   ├── overlays.ts       dialogs and toasts as plain data (a store, promises for the answers): no DOM, no React
│   ├── backlayer.ts      layers the system Back closes: one history entry per open dialog, kept apart from the sheets' own Back handling
│   ├── playlists.ts      playlist names (clean, unique, "… copy") and putting a deleted playlist back
│   ├── playlistfiles.ts  M3U / M3U8 / PLS reading and writing, and tolerant matching of what a file lists to library tracks
│   ├── playlistio.ts     importing playlist files and downloading playlists as files (lazy chunk)
│   ├── download.ts       save a blob as a file
│   ├── share/            listen together: pairing codes, wire protocol, clock sync, drift planning, file streaming, WebRTC peer (lazy chunk)
│   ├── metadata.ts       file helpers (audio/lrc classification, library key), record → track with lazy object URLs
│   └── format.ts         time and total-length formatting, audio-format badge, procedural fallback artwork
├── types.ts              shared domain types (Track, Playlist, Lyrics, PlayerApi, …)
└── components/
    ├── Playlist.tsx      the library panel: list picker, search, mode tabs, sort, the track list or the other views
    ├── TrackList.tsx     the virtualized track rows: play, edit, add to playlist, drag/Alt+Arrow reorder, headings
    ├── Browse.tsx        albums and artists views and their pages (lazy chunk, with GroupPage.tsx and VirtualGrid.tsx)
    ├── SortMenu.tsx, SearchBox.tsx, ModeTabs.tsx, PlaylistMenu.tsx   the panel's controls
    ├── ActionsMenu.tsx   the open playlist's menu: rename, duplicate, save as a file, delete (lazy chunk)
    ├── OverlayGate.tsx, Overlays.tsx   dialogs and toasts: the gate is in the first load, the dialog and toast views are a lazy chunk
    ├── UpNextPanel.tsx   the Up Next tab: play, move, remove, clear (lazy chunk)
    ├── StorageSection.tsx  Sound & tools → Storage: usage, protection, largest tracks, the offline copy and its updates
    ├── NowPlaying.tsx    center stage: artwork, title, empty state
    ├── PlayerBar.tsx     persistent transport + seek + volume
    ├── Slider.tsx        styled range input
    └── Cover.tsx         embedded or generated artwork
```

State lives in a single `usePlayer` hook. Tracks are held as object URLs created from the `File` objects you choose; they are revoked when removed. Nothing is persisted or sent anywhere.

## Privacy

There are no network calls beyond loading the app itself, and the page's Content-Security-Policy would refuse any other. Listening together talks only to the device you pair with, directly over your local network (no signalling or STUN servers). The Android app is excluded from cloud backups and device transfers, so your library stays on the device. Close the tab and your library is gone from memory.

## License

MIT
