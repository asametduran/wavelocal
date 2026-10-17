# Waveform seek bar and long-form listening (ROADMAP E5)

Status: design for an autonomous build, 2026-10-17. Nobody was asked; every choice below is a call made by the builder from
the code as it stands (checked, not assumed) and from the ROADMAP text of E5. If a call is wrong it is cheap to change: the
parts are separate modules.

## Why

Wavelocal plays music well and is now offline-safe (E4). The next gap is files that are not songs: podcasts, lectures,
audiobooks, DJ mixes, language recordings. People listen to those for hours, over many sessions, at a speed of their own, and
want to find a place in them ("where was the chapter about X", "play this phrase again"). Today a 2-hour file always starts at
0:00, always at the same speed, with a seek bar that says nothing about what is in the file.

## Goals

1. A **waveform seek bar** that shows the shape of the file and is as accessible as today's slider.
2. **Chapters** shown and navigable (ID3 `CHAP`/`CTOC`, MP4 `chpl` and QuickTime chapter tracks, Vorbis `CHAPTERxxx` tags).
3. An **A-B loop** to repeat a passage, for any track.
4. **Bookmarks**: named positions per track that survive restarts and are in the JSON backup.
5. **Long-form mode**: a long file remembers where you stopped and the speed you chose for it, and offers 15 s back / 30 s forward.
6. Everything computed **on the device, lazily, once**, and cached; nothing leaves the device.

## Non-goals

- No cloud sync, no accounts, no podcast feeds or downloads, no DRM formats (AAX, M4B with FairPlay).
- No waveform *editing*, no cutting, no silence skipping (parking lot), no DSP changes.
- No waveform for a compressed file too long to decode safely when the format cannot be sliced (the plain bar stays; this is said in the UI, never an error).
- Chapters are read, not written (the tag editor keeps the frames it does not edit, as it already does).

## Anti-goals (would make this a failure even if it "works")

- Any visible slowdown or jank in playback, or in start-up (the initial JS budget is 125 kB; 123.6 kB is used).
- Breaking the existing seek bar: a native `input[type=range]` named "Seek", driven by `fill()` in 30+ e2e tests, keyboard, touch, TV D-pad, screen readers.
- A decoded multi-hundred-megabyte buffer for a long file (renderer crash on phones).
- Raising the IndexedDB version: an old window that is still open (the E4 update flow keeps it open on purpose) would block the new window's upgrade and the library would not load. **No schema change.**
- Losing a bookmark or a resume point silently.

## Facts the design rests on (verified in the code)

- `Transport` (`components/PlayerBar.tsx`) renders `Slider` (a native range input, `aria-label="Seek"`, step 0.1) and is mounted **twice**: the md+ footer and the phone's Now Playing sheet, both always in the DOM (one hidden by CSS). Anything per-track must therefore live in a **shared singleton store**, not in component state.
- `usePlayer.ts` (1,544 lines, start-up chunk) owns `speed` (global, saved in localStorage `Settings`), `pendingSeek` (applied at `loadedmetadata`), a global resume point `meta.resume = {id, time}` saved every 5 s, and the two-deck engine. Transitions (gapless, crossfade) start from `onTime` when `remaining <= lead`.
- IndexedDB `wavelocal` v1 has `tracks` (record with the audio `File`) and `meta` (out-of-line keys, `getMeta/setMeta`). `patchTracks` updates a record without rewriting others.
- Lossless (WAV/FLAC) decoding is pure TypeScript with chunk iterators (`wavChunks`, `FlacDecoder.frames`) and a module worker (`audio/decode.worker.ts`). The container probes (`audio/probe/*`) read headers through a `ByteSource` (random access over a Blob); `probeMp4` already walks boxes and reads `moov`, `readId3Text` already walks ID3 frames.
- Compressed audio is decoded by the browser (`OfflineAudioContext.decodeAudioData`), main-thread API, whole file in memory (`loudness.ts` guards by *file* size, 60 MB, which is not a memory bound: a 60 MB MP3 is about an hour and decodes to over a gigabyte).
- Free global keys: `b`, `c`, `l`, `,` `.` (taken: space m s r n p / t e ? and the arrows). AltGr keys (`[` `]` on a Turkish keyboard) are filtered out as Ctrl+Alt, so brackets are not usable.
- CSP (`default-src 'none'`, `worker-src 'self'`): no inline script, no `data:` images, no `blob:` workers. A worker must be a same-origin file; canvases are fine.
- E2E helpers: `seekBar` = `footer.getByRole('slider', {name:'Seek'})`, `seekTo` = `fill()`. Fixtures are generated (`wav()`, `tone()`, `flac()`, `song()` with ID3 frames).

## Design

### 1. Persistence (no schema change)

Everything new goes into the existing `meta` store under prefixed keys, read and written by a small raw accessor added to `db.ts`
(`getRaw`, `setRaw`, `deleteRaw`, `keysWithPrefix`):

| Key | Value | Notes |
|---|---|---|
| `peaks:<trackId>` | `{ v:1, duration, length, peak: Uint8Array, rms: Uint8Array }` or `{ v:1, none: 'unsupported' \| 'too-long' }` | about 2 kB; derived data, never backed up |
| `chapters:<trackId>` | `{ v:1, chapters: Chapter[] }` (empty = looked, found none) | derived |
| `listen:<trackKey>` | `{ at, t?, speed?, mode?, bookmarks: Bookmark[] }` | user data; keyed by the dedupe `key` (name\|size\|lastModified) so it survives removing and re-adding a file; bookmarks go into the backup |

Garbage collection runs once when idle after hydration, in the lazy code only: `peaks:`/`chapters:` of tracks no longer in the library
are deleted; a `listen:` entry without bookmarks is dropped after 180 days idle or beyond the 400 most recent; entries with bookmarks are kept.

### 2. Peaks pipeline (`lib/waveform/`)

- **Shape.** 1,024 buckets per track. Per bucket the loudest sample and the RMS, each stored as a byte on a dB scale
  (`level = clamp(1 + 20*log10(v)/50, 0, 1)`, so -50 dBFS and below is flat and speech stays readable).
- **`PeakBuilder`** (pure): takes PCM chunks (`Float32Array[]`, any channel count; peak is the max over channels, RMS over all),
  accumulates fixed ~25 ms micro-windows (time exact, independent of the file's length), and `finish(1024)` merges them
  (max for peaks, frame-weighted mean square for RMS). Memory is 8 bytes per micro-window (a 3-hour file: 3.5 MB), never the audio.
- **Strategy by format** (`planPeaks`, pure, from the sniffed/probed container, duration and size):
  1. **WAV, FLAC** → pure-TS chunk iterators in a **dedicated module worker** (a second instance of `decode.worker.ts`, so a
     peaks job never queues behind a FLAC being converted for playback). The job yields every ~25 ms so `cancel` is heard. Any length up to 512 MB.
  2. **MP3, ADTS/AAC** → **sliced `decodeAudioData`**: the file is cut at byte offsets after the ID3 tag into windows of about
     90 s (bytes from `size/duration`, 256 KiB to 24 MiB); the decoder resynchronises on the first frame it finds, so no frame
     parsing is needed. Each window is decoded, scanned and released; windows are placed in time by the *decoded* length of the
     ones before, so VBR drift is nil. Memory per window is bounded (about 35 MB), any file length.
  3. **Everything else the browser can decode** (M4A/M4B AAC and ALAC, Ogg Vorbis/Opus, FLAC the browser plays, AIFF) → **whole
     `decodeAudioData`** only if `duration * sampleRate * channels * 4 <= 200 MB` (about 9 minutes of stereo 44.1 kHz); otherwise the record is `none: 'too-long'` and the plain bar stays.
- **Scheduling** (`waveform/service.ts`, a singleton): one job at a time, started about 1 s after a track becomes current so
  start-up and the first seconds of playback are untouched; aborted when another track becomes current (unless that one is
  already cached); results cached with `setRaw`. A failure is remembered for the session only, except `unsupported`/`too-long`,
  which are deterministic and stored.
- **Limits.** Peaks need the real file: a tag edit rewrites the file but not the audio, and peaks are time-based, so they stay valid.

### 3. The waveform layer and the seek bar

- `Transport` keeps the native range input exactly as it is (same element, same name, same `fill()` behaviour) and gains a
  wrapper `div.seek` plus a sibling `<Deferred><WaveLayer/></Deferred>`. While the chunk loads, or when peaks do not exist, nothing
  changes visually. When the layer is ready it sets `data-wave="on"` on the wrapper and CSS restyles the input: transparent track,
  a 2 px thumb as the playhead (so the pointer-to-time mapping is linear over the whole width), a focus ring on the wrapper.
- `WaveLayer` draws two canvases once per size/palette change (not per tick): the waveform in a muted colour and the same in
  the accent colour. Progress is a CSS `clip-path` driven by the existing `--p` variable (compositor only, no redraw at 4 Hz).
  Bars are drawn per pixel column (2 px bar, 1 px gap, mirrored, RMS body inside the peak outline, minimum 2 px so silence is
  visible). Colours come from the page's CSS variables; with `forced-colors: active` they come from system colours.
  Chapter ticks, bookmark flags and the A-B region are drawn on a third small canvas. Everything is `aria-hidden`; the input
  is the control. A pointer-move on the wrapper shows a time tooltip with the chapter name.
- A setting "Seek bar: Waveform / Plain" (default Waveform) is read by the lazy layer (`useStored`), so the start-up code does not know it.
- Heights: footer 36 px, phone sheet 56 px, TV scaled by the root font size.

### 4. Chapters (`lib/chapters/`)

- **ID3v2.3/2.4 `CHAP`**: element id (NUL-terminated), start/end ms, two offsets (ignored), then embedded frames of which `TIT2`
  is the title (`TIT3` is kept as a subtitle). `CTOC` orders and, when present, restricts the list to the top-level order.
  Artwork inside chapters is never read. Frame size, tag size and count are bounded; unsynchronisation, v2.4 size indicators
  and the four text encodings are handled with the existing helpers.
- **MP4**: `moov/udta/chpl` (Nero; version 0/1, 100 ns units, UTF-8 titles) and the QuickTime chapter track (`tref/chap` pointing
  at a `text` track; sample times from `stts`, sizes from `stsz`, offsets from `stco/co64/stsc`, text = 16-bit length + UTF-8/16).
- **Ogg/FLAC Vorbis comments**: `CHAPTER001=00:00:00.000` with `CHAPTER001NAME=...`.
- **Normalisation** (one pure function for all sources): trim and strip control characters from titles (120 chars), drop
  entries with a non-finite or negative start or a start beyond the duration, sort by start, remove duplicates, end = next start
  (last = duration), at most 1,000. "Current chapter" = the last whose start <= time.
- Read lazily from the stored file by `ByteSource` slices when a track becomes current; cached under `chapters:<id>`.
  Untrusted input: seeded fuzz tests like the other parsers.

### 5. A-B loop

- State `loop: {a, b} | null` in `usePlayer` (tiny): set only through `setLoop`; cleared on any track change and on `clear`.
  While active: gapless/crossfade preloads and transitions are not started, `ended` jumps to `a` instead of `next`, and a
  `setTimeout` chain scheduled from the remaining time (`(b - t) / rate`), re-armed on seek/rate/pause, jumps to `a` within a few
  milliseconds of `b` (timeupdate alone is 250 ms coarse). Minimum length 0.5 s. `b` is capped 0.5 s before the end.
- UI: **A**, **B**, **clear** buttons in the extras row and the `L` key (first press sets A, second sets B, third clears).
  The region is drawn on the waveform and announced ("Loop 1:02 to 1:19").

### 6. Bookmarks

- `Bookmark = { id, t, label, at }`, sorted by `t`, at most 200 per track, labels trimmed to 80 characters. Added at the current
  position with the `B` key or a button; default label "Bookmark N"; renamed with the existing prompt dialog; deleted with an
  Undo toast. Flags on the waveform; a list with jump buttons in the chapters modal.
- Backup: `BackupTrack` gains an optional `bookmarks` array (validated like every other field; older backups restore unchanged);
  restore merges by `t` (within 0.5 s counts as the same).

### 7. Long-form mode (`lib/listening/`)

- **Who is long-form**: setting "Remember position for": Never / files longer than 5, 10, **20** (default), 30, 60 min / Every
  file; per track an override (Automatic / Always / Never) in the chapters modal, stored as `mode` in `listen:<key>`.
- **Resume**: position saved every 5 s while playing (piggybacking the existing resume timer), on pause, on track change and on
  `pagehide`; only between 5 s and `duration - 15 s`; reaching the end deletes it. A track that loads restores
  `max(0, t - 3)` (a 3 s rewind) through `pendingSeek` (so there is no audible blip), with a toast "Resumed at 1:23:45" and a
  **Start over** action. The global resume point of the last track keeps working as it does today.
- **Speed**: the speed a person sets while a long-form track plays is stored for that track; entering it applies it; entering a
  normal track restores the *usual* speed (kept separately, updated whenever speed is changed on a normal track). This needs no
  change to how `usePlayer` stores `speed`.
- **Skip**: Back 15 s / Forward 30 s buttons in the extras row for long-form tracks; Media Session `seekbackward`/`seekforward`
  handlers are registered while one is current (the lock-screen and notification controls of Android and desktop browsers).
- Sleep timer, normalisation, EQ memory and the rest are untouched.

### 8. Surfaces

- **Extras row** under the seek bar (lazy `SeekExtras`): current chapter (button, opens the modal; also a polite live region
  that announces chapter changes), A, B, clear, bookmark, and for long-form tracks the two skip buttons.
- **Chapters and bookmarks modal** (`lazyPanel`, the same pattern as the tools and shortcuts panels, so it has the focus trap,
  `inert` background, Back/Escape handling and axe coverage for free): chapters list (current highlighted, click to jump), bookmarks list,
  the per-track long-form mode, a "Resumed from" line.
- **Settings**: a "Long-form listening" section in Sound & tools (threshold, seek bar style).
- **Keys** (handled by the lazy controller, which ignores typing contexts like the global ones): `L` loop, `B` bookmark,
  `C` chapters, `,` / `.` previous / next chapter. Listed in the `?` overlay.
- **Controller**: one lazy `ListeningController` mounted in `App`, the only place with effects (resume, speed memory, loop timer
  re-arming, media session, keys), so the two `Transport` instances stay dumb.

### 9. Start-up budget

The start-up chunk may grow by about 0.9 kB: the wrapper and two lazy mounts in `Transport` (about 0.3), `loop` state and its
guards in `usePlayer` (about 0.35), the resume hook in `load` (about 0.1), the lazy controller and modal in `App` (about 0.15).
Measured with `npm run size` after every stage. If it does not fit, the loop runner moves behind a dynamic `import()` first; the
budget is raised only as the last resort and the commit says so.

## Stages (each ends verified and pushed; E5 is ticked after stage 5)

1. **Peaks and the waveform bar.** `db.ts` raw accessor; `PeakBuilder`; planner; lossless worker job; sliced and whole native
   decode; cache and service; `WaveLayer`; CSS; setting. *Done when:* a tone-silence-tone WAV shows the right shape, the same for
   FLAC, the cache makes the second open instant (no decode), the plain bar still passes every existing seek test, size within budget.
2. **Chapters.** Parsers, normalisation, cache, chips in the extras row, modal list, `,` `.` `C`. *Done when:* an MP3 with `CHAP`
   frames and an MP4 with `chpl` (synthetic builders) list, jump, and highlight the current chapter; fuzz tests green.
3. **A-B loop and bookmarks.** `loop` in `usePlayer`; bookmarks CRUD with Undo; flags and region; backup field. *Done when:* the
   playhead provably stays inside [A, B] for several loop cycles in a real browser, and bookmarks survive a reload and a backup round trip.
4. **Long-form.** Store, policy, controller, resume with rewind and toast, per-track speed, skip buttons, media session, settings.
   *Done when:* a long-form track resumes after a reload and after playing another track, speed follows the track, music is unaffected.
5. **Polish and proof.** Shortcuts overlay, README, axe on every new surface at phone/tablet/desktop/TV sizes, bundle budget,
   full unit + e2e + desktop, ROADMAP and changelog.

## Test plan

- **Unit (Vitest, node where possible):** `PeakBuilder` (constant tone, silence gap, impulse, clipping, 1-sample and empty input,
  micro-window merge exactness, dB scale), planner decisions and MP3 window arithmetic, lossless peaks against a direct
  computation on `test-utils` WAV/FLAC, raw accessors and cache validation, every chapter parser with synthetic builders
  (encodings, v2.3/v2.4, `CTOC`, 64-bit MP4 boxes, truncated and hostile input), the normaliser, loop maths, bookmark CRUD and
  caps, long-form policy (threshold, finished, rewind, pruning), backup round trip with bookmarks. Seeded fuzz for the three
  chapter parsers (time budgets in CPU time, see `test-utils/fuzz.ts`).
- **E2E (Playwright):** waveform appears and is cached (reload shows it without decoding); keyboard (arrows, PageUp/Down, Home/End)
  and pointer seeking on the layered input; plain fallback for undecodable files; chapters list and jump; bookmarks add / rename /
  delete / undo / persist; A-B loop keeps `currentTime` within bounds; long-form resume across reload and track switches;
  per-track speed; phone, tablet, desktop and TV layouts; axe; no CSP violations (`policyViolations()` empty).
- **Real-codec fixtures:** a few-kilobyte real MP3 (and, if it helps, M4A and Ogg) generated once from a synthetic tone and kept as
  a base64 constant in `test-utils/`, because sliced and whole `decodeAudioData` can only be proven in a real browser.

## Risks and how they are covered

| Risk | Cover |
|---|---|
| Chromium rejects an MP3 slice that starts mid-frame | e2e on a real MP3; fallback: align the window start to the next `0xFFEx` sync found by a bounded scan |
| `decodeAudioData` memory on phones | windows of 90 s (about 35 MB); the whole-file path is capped at 200 MB decoded; `none: 'too-long'` is a normal state |
| Two `Transport` instances double the work | one singleton store and one job queue; the hidden instance draws nothing (zero width) |
| Start-up budget | staged measurement; dynamic `import()` for the loop runner; raise only as last resort |
| An A-B loop fights gapless/crossfade | `loop` suppresses transitions and `ended -> next`; covered by a crossfade-on e2e |
| Resume and the global resume point disagree | the per-track resume is applied through `pendingSeek` only when `time < 1` after load; both come from the same timer |
| Hostile tags (`CHAP` bombs, huge text) | bounded reads, counts and lengths; seeded fuzz tests; titles sanitised |
| Old window open during an update | no IndexedDB version bump; new keys are additive and ignored by old code |

## Stage 4 as built (where it differs from the design above)

- **Where a place is kept.** Not in `listen:<key>`: a place is written every five seconds while a recording plays, and rewriting a
  record that can hold 200 bookmarks each time would be wasteful and would put the bookmarks at risk of a failed write. It is
  `heard:<library key>` = `{ v: 1, at, t, speed, mode }` in `meta` (`lib/listening/progress*.ts`): still no schema change, still
  keyed by `name|size|modified` so it outlives removing and adding the file, and not in the backup. A record with nothing to
  remember is not kept; places nobody came back to for 180 days (or beyond the 400 most recent) are forgotten when the browser is
  idle, a choice made for a track (`always`, `never`) never is.
- **The rules are one object.** `LongFormSession` (`lib/listening/session.ts`) is told what the player does (`update`, a few
  times a second) and answers through a port (seek, speed, toast, clock, the usual speed): no timer, no database and no React
  inside, so the unit tests wind a clock by hand. `hooks/useLongForm.ts` lends it the player and is the only place with effects.
- **A place is the beginning or the end of nothing.** Before 5 s or within 15 s of the end the place is forgotten, and a place is
  only kept for a track that was played during the visit (opening a track and leaving it never moves its place: the 3 s rewind
  would otherwise creep back with every visit).
- **Nothing is kept while the playhead has not arrived.** After the session sends the playhead to the place, what the player
  reports (still the start, on a slow disk) is not where the person is, so nothing is written until it has reached the place or
  plays on from somewhere else.
- **The first track of a page is always taken up.** The player puts its playhead back where it left it as soon as the file is
  read, which happens before this lazy code runs (or after it, on a fast machine): a rule that looked at the playhead made the
  resume a race, found by the first e2e run. Later tracks are taken up only while their playhead is still at the start.
- **Speed.** A speed the person chooses on a long recording is kept for it; on anything else it becomes the usual speed
  (`wl.usualspeed`, kept apart: the player's own saved speed is whatever the last track needed). A change of speed is told from the
  session's own by looking at whether it differs from the report before and from what the session asked for.
- **Shared sessions.** A guest follows the host's track, place and speed, none of which is the guest's own listening: the hook
  gives the session no track then (it keeps the place of the one that was playing and stands down).
- **Media Session.** The player already registered `seekbackward` and `seekforward` with a 10 s default; it now reads the step
  from `lib/mediaskip.ts` (start-up chunk, a few lines), which `useLongForm` sets to 15 and 30 while a long recording is current.
  A step the platform sends with the button still wins.
- **Surfaces.** The skip buttons flank the loop and bookmark group (not inside it, so its name and every stage 3 test stand); the
  choice for one track (Automatic, Always, Never; Never forgets what was kept) is in the chapters dialog; the length is chosen in
  Sound & tools under *Long recordings*, with a *Forget saved places* button that says how many recordings it is about.
- **Budget.** Initial JS stays at 124.6 of 125 kB. A first build gave 124.9: importing `RovingGroup` into the chapters dialog
  changed which lazy chunks share `useA11y`, and the bundler split `a11y` out of the entry chunk (a chunk of its own costs more
  than the module did). The dialog uses `useRovingKeys` directly instead.

## Calls made without asking

Threshold default of 20 minutes; 3 s rewind on resume; skip 15/30 s; 1,024 buckets; dB scale of 50 dB; 400 position-only entries;
keys L B C , .; bookmarks in the backup but resume points not; no waveform for non-sliceable compressed files beyond 200 MB decoded;
`meta` prefixed keys rather than new stores.
