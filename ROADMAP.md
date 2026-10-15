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
- [ ] A4. Migrate all components and entry points to `.tsx`; typed props everywhere
- [ ] A5. Turn on full strictness (`strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`), get `npm run typecheck` to zero errors, make `npm run build` run the typecheck first, document in README

### Pack B - Automated headless testing with synthetic audio
- [ ] B1. Vitest + jsdom setup (`npm test`); unit tests for `lrc`, `format`, `loudness` (gainFromSamples), metadata pairing and ReplayGain parsing, queue/next/prev/shuffle logic extracted into pure functions
- [ ] B2. Synthetic audio pipeline: a test utility that generates WAV buffers/files (sine, sweep, silence, clipping, different loudness) used by unit and e2e tests
- [ ] B3. Playwright headless e2e (`npm run test:e2e`): import synthetic files, play/pause/seek, queue reorder, search, playlists, persistence across reload, lyrics sync, EQ preset, sleep timer, crossfade track switch
- [ ] B4. CI workflow `.github/workflows/ci.yml` running typecheck + unit + e2e on every push/PR (separate from the APK workflow); cache Playwright browsers; upload failure traces

### Pack C - Advanced DSP audio engine
- [ ] C1. 3D spatial audio: `PannerNode` (HRTF) with a position pad UI, auto-rotate "8D" mode, wet/dry and distance controls
- [ ] C2. Reverb room simulation: `ConvolverNode` with procedurally generated impulse responses (small room, hall, cathedral, plate), pre-delay, decay, wet/dry mix
- [ ] C3. Parametric EQ: editable band frequency, Q and gain with draggable response curve, band types (peak, shelf, notch), keep the 10-band graphic EQ as a preset view; save/load custom presets
- [ ] C4. Dynamics and stereo: compressor/limiter, stereo widener, mono downmix, bass/treble shelves, per-track EQ memory
- [ ] C5. Lossless decoder fallbacks: robust WAV and FLAC support when the browser cannot play them natively (detect with `canPlayType`; pure-JS or WASM decoder to `AudioBuffer`, streamed playback path); tests with synthetic WAV/FLAC fixtures

### Pack D - Desktop app with tray and global hotkeys
- [ ] D1. Electron wrapper under `desktop/` (main + preload, secure defaults: contextIsolation, no nodeIntegration, CSP) loading the built web app; `npm run desktop:dev` and `desktop:build`
- [ ] D2. System tray: icon, play/pause, next/previous, show/hide window, quit; minimize-to-tray; now-playing tooltip fed from the renderer through a typed IPC bridge
- [ ] D3. Global media hotkeys via `globalShortcut` (play/pause, next, previous, volume) with user-configurable accelerators and conflict handling; renderer feature-detects the bridge so the web/PWA build is unaffected
- [ ] D4. Packaging: `electron-builder` config for Windows (NSIS) and a CI job that builds the installer artifact on `windows-latest`

## Backlog (smaller items, only when the packs are blocked)
- [ ] Tag editor: edit and save ID3 title/artist/album/cover
- [ ] Folder tree browser (use `webkitRelativePath`)
- [ ] Performance audit: Lighthouse pass, bundle splitting, lazy-load modals, memory use with huge libraries
- [ ] Accessibility audit: screen-reader labels, focus order, reduced-motion support
- [ ] WebRTC local LAN music sharing / synced listening (serverless pairing via QR or copy-paste signalling)
- [ ] Smart playlists (recently added, most played, never played) with play counts stored locally
- [ ] Import/export library metadata and playlists (JSON) for backup

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
