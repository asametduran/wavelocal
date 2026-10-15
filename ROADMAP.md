# Wavelocal Roadmap

Living plan for the autonomous evolution loop (`loop.ps1`). Each run picks **one** unchecked item (top-most first
unless a bug or perf issue is more valuable), implements it end to end, verifies `npm run build` exits 0, ticks the box,
and pushes to `main` (which also triggers the Android APK build).

## Rules for every run
- One focused improvement per run; keep the diff reviewable. Never break existing features.
- Stay local-first and privacy-first: no analytics, no ads, no accounts, no network calls for user audio.
- `npm run build` must exit 0 before committing. If it can't be fixed, revert and note the blocker below.
- Update this file (tick the box, add follow-up ideas, append one line to the Changelog).
- Commit with a conventional message (`feat:`, `fix:`, `perf:`), then `git pull --rebase origin main` and `git push origin main`.

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

## Next up (in rough priority order)
- [x] Virtualized track lists so libraries of 10,000+ songs scroll smoothly (windowing, no extra deps if practical)
- [x] ReplayGain / loudness normalization (computed RMS estimate with peak limiting, toggle in Sound panel; reading ReplayGain tags is a follow-up)
- [x] Read ReplayGain tags (TXXX REPLAYGAIN_TRACK_GAIN) and prefer them over the computed estimate
- [x] Pitch and speed control (playbackRate with preservesPitch toggle, 0.5x-2x, reset button)
- [x] Custom themes and accent colors (CSS variables, presets + custom picker, persisted)
- [ ] Tag editor: edit and save ID3 title/artist/album/cover (write tags into a downloaded copy or back to the stored blob)
- [ ] Folder tree browser (use webkitRelativePath to group by directory; browse by folder)
- [ ] 3D spatial audio and reverb (PannerNode / ConvolverNode with generated impulse responses, wet/dry control)
- [ ] Smart audio effects: bass/treble limiter, stereo widener, mono downmix, per-track EQ memory
- [ ] Performance audit: Lighthouse pass, bundle splitting, lazy-load modals, memory use with huge libraries
- [ ] Accessibility audit: screen-reader labels, focus order, reduced-motion support
- [ ] WebRTC local LAN music sharing / synced listening (serverless pairing via QR or copy-paste signalling)
- [ ] Smart playlists (recently added, most played, never played) with play counts stored locally
- [ ] Import/export library metadata and playlists (JSON) for backup
- [x] Keyboard shortcut help overlay (`?`)
- [ ] Unit tests for lrc.js, metadata pairing and queue logic (vitest)

## Ideas parking lot
- Waveform seek bar, mini visualizer in the lock-screen artwork
- Podcast mode (remember position per file, skip silence)
- Album / artist grouped views

## Changelog (one line per autonomous run)
- Initial roadmap created.
- Added speed (0.5x-2x) and keep-pitch toggle to Sound panel, persisted locally.
- Virtualized the library track list (fixed-height windowing with overscan, no new deps).
- Added opt-in volume normalization: per-track loudness measured locally on first play, cached in IndexedDB, applied via a per-deck gain node (also works with crossfade).
- Read ReplayGain track/album gain from ID3v2 TXXX tags at import and use it instead of the computed loudness estimate (clamped to ±12 dB).
- Added accent color picker (8 presets + custom) in the Sound panel, driven by a CSS variable and persisted locally.
- Added a keyboard shortcut help overlay opened with `?` (closes with Esc or click outside).
