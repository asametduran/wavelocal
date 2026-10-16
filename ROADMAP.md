# Wavelocal Roadmap

Living plan for the autonomous evolution loop (`loop.ps1`) in **HYPERCODE mode**: the loop runs continuously,
one headless Claude Code session after another, and only pauses when the Claude Pro quota is exhausted.

## Rules for every run
- Pick the **first unchecked milestone** in the HYPERCODE packs below (A, then B, C, D). Fall back to the Backlog only if every pack milestone is blocked.
- A milestone is a **deep engineering deliverable**: multi-file, production quality, with tests where a test runner exists. No 10-line tweaks. If a milestone finishes early and pushed cleanly, continue with the next one in the same session.
- **Verify before every push:** `npm run build` must exit 0, and once they exist `npm run typecheck` and `npm test` must pass. CI (`.github/workflows/build-apk.yml`) runs `npm ci && npm run build && npx cap sync android`, so keep that path working.
- **Commit and push to `origin/main` after every verified milestone** (conventional message, `git pull --rebase origin main` first). Pushing triggers the Android APK build.
- Stay local-first and privacy-first: no analytics, no accounts, no network calls for user audio. Never commit user audio or large binaries; tests generate synthetic audio.
- Keep the web bundle lean: native/desktop code lives under `desktop/` and must not be imported by `src/`.
- If a milestone is blocked: revert partial work, record the blocker under that item, tick nothing, and move to the next milestone.
- Update this file when done (tick the box, add one Changelog line, add follow-ups).

## HYPERCODE packs

### Pack A - TypeScript migration and strict typechecking
- [x] A1. Add TypeScript tooling: `typescript`, `@types/react`, `@types/react-dom`, `tsconfig.json` (strict, `allowJs` + `checkJs` off for the transition, `noEmit`), `npm run typecheck`; shared domain types (`Track`, `Playlist`, `Lyrics`, `LyricLine`, `PlayerState`, settings) in `src/types.ts`
- [x] A2. Migrate `src/lib/*` (engine, lrc, db, metadata, loudness, format, theme) to `.ts` with precise types, no `any`
- [x] A3. Migrate `src/hooks/*` (usePlayer, useHotkeys, useTvMode, useSwipe) to `.ts`; type the player API returned by `usePlayer`
- [x] A4. Migrate all components and entry points to `.tsx`; typed props everywhere
- [x] A5. Turn on full strictness (`strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`), get `npm run typecheck` to zero errors, make `npm run build` run the typecheck first, document in README

### Pack B - Automated headless testing with synthetic audio
- [x] B1. Vitest + jsdom setup (`npm test`); unit tests for `lrc`, `format`, `loudness` (gainFromSamples), metadata pairing and ReplayGain parsing, queue/next/prev/shuffle logic extracted into pure functions
- [x] B2. Synthetic audio pipeline: a test utility that generates WAV buffers/files (sine, sweep, silence, clipping, different loudness) used by unit and e2e tests
- [x] B3. Playwright headless e2e (`npm run test:e2e`): import synthetic files, play/pause/seek, queue reorder, search, playlists, persistence across reload, lyrics sync, EQ preset, sleep timer, crossfade track switch
- [x] B4. CI workflow `.github/workflows/ci.yml` running typecheck + unit + e2e on every push/PR (separate from the APK workflow); cache Playwright browsers; upload failure traces

### Pack C - Advanced DSP audio engine
- [x] C1. 3D spatial audio: `PannerNode` (HRTF) with a position pad UI, auto-rotate "8D" mode, wet/dry and distance controls
- [x] C2. Reverb room simulation: `ConvolverNode` with procedurally generated impulse responses (small room, hall, cathedral, plate), pre-delay, decay, wet/dry mix
- [x] C3. Parametric EQ: editable band frequency, Q and gain with draggable response curve, band types (peak, shelf, notch), keep the 10-band graphic EQ as a preset view; save/load custom presets
- [x] C4. Dynamics and stereo: compressor/limiter, stereo widener, mono downmix, bass/treble shelves, per-track EQ memory
- [x] C5. Lossless decoder fallbacks: robust WAV and FLAC support when the browser cannot play them natively (detect with `canPlayType`; pure-JS or WASM decoder to `AudioBuffer`, streamed playback path); tests with synthetic WAV/FLAC fixtures

### Pack D - Desktop app with tray and global hotkeys
- [x] D1. Electron wrapper under `desktop/` (main + preload, secure defaults: contextIsolation, no nodeIntegration, CSP) loading the built web app; `npm run desktop:dev` and `desktop:build`
- [x] D2. System tray: icon, play/pause, next/previous, show/hide window, quit; minimize-to-tray; now-playing tooltip fed from the renderer through a typed IPC bridge
- [x] D3. Global media hotkeys via `globalShortcut` (play/pause, next, previous, volume) with user-configurable accelerators and conflict handling; renderer feature-detects the bridge so the web/PWA build is unaffected
- [x] D4. Packaging: `electron-builder` config for Windows (NSIS) and a CI job that builds the installer artifact on `windows-latest`

## Backlog (smaller items, only when the packs are blocked)
- [x] Tag editor: edit and save ID3 title/artist/album/cover
- [x] Folder tree browser (use `webkitRelativePath`)
- [x] Performance audit: Lighthouse pass, bundle splitting, lazy-load modals, memory use with huge libraries
- [x] Accessibility audit: screen-reader labels, focus order, reduced-motion support
- [x] WebRTC local LAN music sharing / synced listening (serverless pairing via QR or copy-paste signalling)
- [x] Smart playlists (recently added, most played, never played) with play counts stored locally
- [x] Import/export library metadata and playlists (JSON) for backup

## Ideas parking lot
- Waveform seek bar, mini visualizer in the lock-screen artwork
- Podcast mode (remember position per file, skip silence)
- Album / artist grouped views

## Done
- [x] Core player: play/pause, seek, volume, shuffle, repeat, search, drag-reorder queue
- [x] ID3 metadata and cover art, procedural fallback artwork
- [x] Universal responsive UI: phone sheets, tablet split view, desktop, TV mode with D-pad navigation
- [x] PWA (manifest + service worker) and Media Session API
- [x] Capacitor Android wrapper and GitHub Actions APK build
- [x] 10-band equalizer with presets, analyser visualizer
- [x] Synced LRC lyrics (sidecar and embedded)
- [x] IndexedDB offline library, playlists, resume position
- [x] Sleep timer with fade-out, gapless and crossfade
- [x] Virtualized track lists so libraries of 10,000+ songs scroll smoothly
- [x] ReplayGain / loudness normalization (computed estimate plus ID3 ReplayGain tags)
- [x] Pitch and speed control (0.5x-2x, preserve-pitch toggle)
- [x] Custom themes and accent colors
- [x] Keyboard shortcut help overlay (`?`)

## Changelog (one line per autonomous run)
- Initial roadmap created.
- Added speed (0.5x-2x) and keep-pitch toggle to Sound panel, persisted locally.
- Virtualized the library track list (fixed-height windowing with overscan, no new deps).
- Added opt-in volume normalization: per-track loudness measured locally on first play, cached in IndexedDB, applied via a per-deck gain node (also works with crossfade).
- Read ReplayGain track/album gain from ID3v2 TXXX tags at import and use it instead of the computed loudness estimate (clamped to +-12 dB).
- Added accent color picker (8 presets + custom) in the Sound panel, driven by a CSS variable and persisted locally.
- Added a keyboard shortcut help overlay opened with `?` (closes with Esc or click outside).
- Switched to HYPERCODE mode: roadmap reorganised into heavy packs A-D (TypeScript, testing, DSP, desktop).
- A1: added TypeScript tooling (tsconfig, `npm run typecheck`) and shared domain types in `src/types.ts`.
- A2: migrated `src/lib/*` to strictly typed TypeScript (no `any`), added jsmediatags typings; theme logic lives in `hooks/useTheme` and migrates with A3.
- A3: migrated all hooks to TypeScript and typed the `usePlayer` return value as `PlayerApi` in `src/types.ts`.
- A4: migrated all components and entry points to `.tsx` with typed props; added a React typings augmentation for folder inputs.
- A5: enabled full strictness (noUncheckedIndexedAccess, noImplicitReturns), build now typechecks first, README documents it; fixed Tailwind content globs to include .ts/.tsx (A4 had purged styles).
- B1: added Vitest + jsdom (`npm test`, 140 unit tests) covering lrc, format, loudness, metadata pairing/ReplayGain, db records and a new pure `lib/queue` module (next/prev/shuffle/reorder) extracted from usePlayer.
- B2: added synthetic audio pipeline in `src/test-utils` (WAV 16/24/float codec, sine/sweep/noise/clipped/loudness generators, ID3v2 builder tested against the real tag reader, named fixture catalog); 225 tests total.
- B3: added Playwright headless e2e (`npm run test:e2e`, 66 tests in real Chromium) covering import, playback, seek, queue reorder, search, playlists, persistence, lyrics sync, EQ/speed/normalization (asserting the live Web Audio graph), sleep timer and gapless/crossfade.
- B4: added `.github/workflows/ci.yml` (typecheck + unit + Playwright e2e on every push/PR, Playwright browser cache keyed by version, traces/report uploaded on failure); separate from the APK workflow.
- C1: added 3D spatial audio (HRTF PannerNode after the EQ, position pad with pointer + keyboard control, distance, equal-power wet/dry, "8D" auto-rotate via scheduled orbit curves); 56 geometry unit tests and 16 e2e tests that read the live panner position.
- C2: added reverb (ConvolverNode with procedural small room / hall / cathedral / plate impulse responses, pre-delay, decay, equal-power wet/dry, debounced and ducked IR swaps, decay-shape preview); 45 unit tests incl. RT60 by Schroeder integration and 14 e2e tests reading the live convolver.
- C3: added a parametric EQ (single band model shared with the 10-band graphic view; editable type/frequency/Q/gain via a draggable, scrollable, keyboard-operable response curve; peak/shelf/notch, up to 12 bands, click-free bypass and add/remove, custom presets; model checked against the browser's real filter response in 27 e2e tests).
- C4: added tone shelves, a compressor (with transfer-curve preview and live meter), a limiter, a mid/side stereo widener and mono downmix, and per-track EQ memory (persisted in IndexedDB); trims Web Audio's hidden compressor make-up gain; 42 dynamics unit tests and 30 e2e tests that measure the real per-channel output.
- C5: added lossless decoder fallbacks: pure-TS WAV (8/16/24/32-bit, float32/64, A-law/µ-law, extensible, RF64) and complete FLAC decoders with CRC/MD5 checks and concealment, streamed to 16-bit PCM in a lazy-loaded Web Worker; detection by content sniffing, canPlayType and native playback errors; also used for loudness measurement; verified sample-for-sample against Chromium's native FLAC decoder.
- D1: added the Electron desktop shell under `desktop/` (separate npm project): the built web app is served from a privileged `app://wavelocal/` origin with a strict CSP, sandbox + contextIsolation, a request filter that cancels all non-local traffic, navigation/window.open/permission lockdown, remembered window bounds, a frozen validated `window.wavelocalDesktop` bridge (`src/desktop-bridge.ts`), `desktop:dev`/`desktop:build`/`desktop:start`; unit tests plus 6 Electron smoke tests (`npm run desktop:test`).
- D2: added the system tray to the desktop shell: icon drawn in code (no image files), now-playing tooltip, context menu (play/pause, next, previous, show/hide, close to tray, quit), minimize/close to tray with a remembered preference, typed validated IPC (frame-checked sender, sanitised text, command whitelist) behind the optional `tray` capability of `window.wavelocalDesktop`, and the `useDesktopTray` hook; 49 new unit tests and 7 Electron tray tests.
- D3: added global media hotkeys: `globalShortcut` bindings for play/pause, next, previous, volume up/down and mute (media keys by default), user-configurable from a Global hotkeys section in the Sound panel (key recorder), with accelerator parsing/canonicalisation, reserved-combination and duplicate checks, atomic changes that keep the old binding when the system refuses, retry of keys another app held, persistence, and the separate `commands`/`hotkeys` capabilities of the feature-detected bridge (web/PWA/Android unaffected); 60+ new unit tests and 6 Electron hotkey tests.
- D4: added Windows packaging: electron-builder config (per-user NSIS installer, web build bundled under resources/web, tests and source maps kept out of the asar), `desktop:dist`/`desktop:pack`, an installer verifier, a packaged-app smoke test, and a `windows-latest` workflow that builds, verifies, smoke-tests and uploads the installer artifact.
- Backlog: added a tag editor (pencil on every library row): edit title/artist/album/cover in an accessible dialog; MP3s get the tags rewritten into the stored copy by a new ID3v2.2/2.3/2.4 rewriter that keeps ReplayGain, lyrics and all other frames and never touches the audio bytes; other formats update the library only; cover validated by magic bytes; "Download copy" hands back the tagged file; 28 unit tests and 9 e2e tests.
- Backlog: added a folder tree browser: the library remembers each file's folder (`webkitRelativePath` from the folder picker, or a recursive `FileSystemEntry` walk for dropped folders), and a Folders toggle in the library header shows it as an accessible virtualized tree (roving-focus arrow-key navigation, search that opens matching folders, remembered open state, Play folder, Save folder as playlist, show playing track, expand/collapse all); old libraries keep working as loose files; 40 unit tests and 16 e2e tests.
- Backlog: performance audit: sound tools, shortcuts, tag editor, folder tree and the tag reader are lazy chunks (with idle preload and a retryable failure notice), React/icons split into long-lived vendor chunks (initial JS 135 kB -> 106 kB gzipped), object URLs minted lazily so a 10,000-track library registers a handful instead of 20,000, `npm run size` budget check in CI, Lighthouse a11y/SEO fixes (main landmark, contrast, robots.txt; 100/100/100); 10 unit and 6 e2e tests incl. a seeded 10,000-track library.
- Backlog: accessibility audit: axe-core e2e scans of every screen (desktop and phone) with zero violations, a shared dialog focus trap with `inert` background and focus return, labelled tab/radio/menu keyboard patterns, a live region announcing track changes, play state, search counts and reorders, `Alt+Arrow` keyboard reordering, spoken slider values, landmarks and skip links, a reduced-motion store (system setting plus in-app override), WCAG contrast maths that lightens unreadable accents and flips the text on accent fills, `prefers-contrast` and forced-colors styles; 54 new unit tests and 24 new e2e tests.
- Backlog: WebRTC LAN sharing / synced listening: a host and up to 6 listeners connect directly with no server (copy-paste invite/reply codes, compressed and CRC-checked; RTCPeerConnection with no ICE servers so nothing leaves the LAN); the host's track, play/pause and seeks are followed using an NTP-style clock offset and drift correction, missing songs stream over a back-pressured data channel (current and next track only, CRC-32 verified, saved to the library), optional listener remote control; lazy controller chunk, status pill, accessible panel; 77 unit tests and 9 two-browser e2e tests (privacy, sync, transfer, control, bad codes, axe). Follow-up: QR display/scan for the codes (needs an encoder/decoder dependency).
- Backlog: smart playlists: Recently added / Most played / Recently played / Never played in the library menu with live counts; tracks now carry `addedAt`, `plays` and `lastPlayedAt` in IndexedDB (old libraries are upgraded on read and ordered by import position); a play counts after half the track or 30 s of real listening (a tally ignores pauses and seeks); smart lists are read-only, ordered when opened so rows do not jump during playback, show "12 plays" / "added 2 days ago" details, and play counts can be cleared; 38 unit tests and 12 e2e tests (counting, persistence, legacy library, read-only, axe).
- Backlog: JSON backup/restore: Sound & tools exports tags, lyrics, play counts, added dates, per-track EQ and playlists (by library key, no audio or artwork) and restores them as a previewed, idempotent merge (tags/lyrics from the backup win, counters only grow, playlists merge by id or name, nothing is removed); entries whose files are missing are kept as a pending restore (persisted in IndexedDB) that completes by itself, in the original playlist order, as files are added, even across restarts; the file is validated as untrusted input (size caps, per-field sanitising, damaged entries skipped and counted); 32 unit tests (incl. a 20,000-track merge) and 12 e2e tests (download, same- and cross-device restore, pending completion, errors, axe).
