# Fault containment and playback recovery (ROADMAP F2)

Status: design for an autonomous build, 2026-10-18. Nobody was asked; every choice below is a call made by the builder from the code as
it stands and from experiments that failed against the production build. Claims marked **(to verify)** are hypotheses the first stage
checks before it builds on them; the *As built* section at the end records what turned out.

## Why

Wavelocal keeps playing through most things, but four failures end in a page or a player that is wrong without saying so:

- **C. An unplayable file as the next track stops gapless and crossfade playback while the screen says it is playing.** The idle deck's
  `error` event is dropped (`isActive` in `usePlayer.ts`), so the hand-over in `beginTransition` lands on a deck that cannot play: the title
  changes, the button reads *Pause*, nothing sounds and nothing moves on, for ever (audit experiment C, Gapless and Crossfade; with
  transitions Off the same file is skipped as designed). `inEl.play().catch(() => {})` hides the rejection.
- **A queue with nothing playable never stops retrying.** With every file unplayable and repeat on, the skip chain restarts itself: 428
  `play()` calls in 6 s on the build before F1 (found while verifying F1; on the F1 build 3 attempts to 80 within 1.5 s depending on
  timing). `onErr` falls through to `skipUnplayable` for an `error` event whose `src` is no longer the current track's, so a late event
  is counted as a new failure, the "None of the next tracks could be played" cap trips every third failure and the chain starts over.
  `onPlay` also resets the streak, and a real browser fires `play` for every attempt, so the cap may not hold at all there **(to verify
  with real garbage files, no stub)**.
- **No safety net around the page.** Nothing above `<App />` catches a render error, and no `error` / `unhandledrejection` listener
  exists: a throw outside a lazy panel leaves a blank page, on every start when stored data is the cause. The one boundary there is
  (`ChunkBoundary` in `components/lazy.tsx`) says *Could not load X. Check your connection* for any error in a lazy panel, which is
  wrong for a bug.
- **Failures vanish.** There are 127 `.catch(() => {})` / `catch {}` in `src/` (55 files); the ones that hide a failed save, decode or
  worker leave no trace, so a person cannot say what went wrong and neither can the next run of this loop.

## Goals

1. An unplayable file is **skipped with a notice that names it**, and playback carries on, in every transition mode. Each failing source
   counts **once**. A queue with nothing playable ends with **one** notice and **no further attempts**.
2. A render error shows a **recovery screen from the start-up chunk** (no lazy chunk, no app state, no database): *Reload*, *Start fresh*
   (keeps the music and playlists, forgets settings and where you were) and *Copy details*.
3. A **bounded, local-only error log** (`error`, `unhandledrejection`, boundary catches, and the failures that used to be swallowed) is
   shown in Sound & tools → Diagnostics with a **copyable report that leaves out file names and tags**.
4. The swallowed failures of saves, decodes, workers and the player's own `play()` calls are **routed to the log**.
5. Nothing is sent anywhere, the log never holds a file name or a tag on purpose, and no stored data changes shape.

## Non-goals

- No remote reporting, analytics or automatic bug reports. The report is only copied if the person chooses.
- No handling of a throw before the start-up chunk has run (a module that fails while loading): no code of ours is running yet.
- No repair of the library (F1), no change to the lossless decode fallback.
- Not all 127 swallowed catches: most are harmless (feature detection, best-effort cleanup). Only failures a person would want to know of.

## Anti-goals (would make this a failure even if it "works")

- A recovery screen that depends on a lazy chunk, on the player's state or on IndexedDB: it must work when all of those are the problem.
- A skip that hides a real failure: every skip has a notice naming the file, and the log has the reason.
- A log that leaks: free text is redacted *and* the app writes structured entries (a kind, a code) wherever it can.
- A larger start-up bundle than it needs: the initial JS is 122.7 of 125.0 kB. The boundary and the capture hooks are start-up code and
  must stay small (about 1.2 kB gzipped between them); the log, the redaction, the report and the Diagnostics section are lazy.

## Facts the design rests on (verified in the code)

- `onErr` (usePlayer.ts, in the audio-element effect) ignores events when `e.target !== getEl()`; for the active deck it retries a
  lossless file through the decoder when `src === current.url`, and otherwise calls `skipUnplayable` directly.
- `skipUnplayable` counts `++failStreak` against `max(1, playQueue.length)`; `onPlay` sets `failStreak = 0`.
- `beginTransition` sets `inEl.src` only when it differs from the preloaded one, so an `error` that fired during preload is not repeated.
- `pickTrack` (lib/queue.ts) is pure and takes no notion of tracks to avoid.
- `main.tsx` renders `<StrictMode><App /></StrictMode>` and nothing else; `index.html` has no inline script (the build's CSP forbids it).
- The overlays store (`toast`, `noticeDialog`) works from anywhere, including start-up code.
- `localStorage` holds the settings (`wl-settings`) and small `wl.*` choices; the library, the places and the queue are in IndexedDB.

## Design

### 1. Playback faults (`lib/faults.ts`, pure, and the wiring in `usePlayer.ts`)

A small framework-free class decides what an `error` event means:

- `attach(deck, trackId, url)` records the source a deck was given (called wherever the player sets `src`: `load`, the decode retry,
  the preload, `beginTransition`).
- `fail(deck, currentSrc)` answers `ignore` when the event is stale (the deck has another source now) or a duplicate (that source has
  already failed), otherwise marks the source failed and the track unplayable for this session and answers with the track id.
- `isUnplayable(id)` / `forget(id)`; asking for a track by hand (`play`, `playFrom`) forgets it, so a transient failure is retried when
  the person asks.
- The streak is reset by **progress** (the playhead moved, or the track ended), not by `play`.

`pickTrack` gets a `skip` set and walks past those ids (bounded by the queue's length; all skipped means no track), so a known-bad
track is never chosen again and a queue of bad tracks ends the chain by itself. The wiring: `onErr` asks the faults object first;
an idle deck's failure marks the pending track (clears `x.pending`, says *"X can't be played and will be skipped"* once); `beginTransition`
does not hand over to a track that is marked, and treats a `NotSupportedError` from `play()` as that track's failure (not
`NotAllowedError`, which is the autoplay policy and not the file's fault); a failed hand-over that already moved the screen goes on with
`next` at once.

### 2. The root boundary (`components/RootBoundary.tsx`, start-up code)

A class component around `<App />` in `main.tsx`, written with plain elements and classes already in the stylesheet (no icons, no
overlays, no lazy imports). It shows what happened in one sentence, and three buttons:

- *Reload*: `location.reload()`.
- *Start fresh*: asks once more in place (the copy says what is kept: the music and the playlists; and what is forgotten: settings, where
  you were, the queue), then removes the `wl*` keys of `localStorage` except the log, sets a one-time `sessionStorage` flag and
  reloads. The next start reads the flag in the hydration code and applies no resume point, no Up Next and no pending restore.
- *Copy details*: the redacted report (below) to the clipboard, with the text shown in a box when the clipboard is refused.

`getDerivedStateFromError` keeps the error; `componentDidCatch` records it in the log (the lazy module, with an inline fallback that
keeps only the error's name and the code frames of its stack, never its message, when the chunk cannot be fetched).

### 3. The log (`lib/diagnostics/log.ts`, lazy; capture in `lib/diagnostics/capture.ts`, start-up)

- `capture.ts` installs `window` `error` and `unhandledrejection` listeners at module load and hands each error to the log, lazily; it
  keeps a small bounded queue of raw errors for the case that the chunk cannot be fetched.
- Entries: `{ at, kind, name, message, frames, count }`. `kind` is a small closed set (`error`, `rejection`, `boundary`, `save`, `decode`,
  `worker`, `play`, `library`). Bounds: 50 entries, 300 characters of message, 12 frames of 160 characters; the same entry in a row is
  one entry with a count. Persisted in `localStorage` under `wl.diagnostics` (at most 24 kB), read back through a validator (a damaged
  value reads as an empty log).
- `redact(text)`: quoted text, anything that looks like a file name or a path, URLs (`blob:`, `http(s):`, `app:`), e-mail-like text and
  long digit runs are replaced; what is left is capped. The report adds the app's build id, the browser and platform, and the entries; it
  never adds settings, library counts or names.

### 4. Diagnostics (`components/DiagnosticsSection.tsx`, inside the Sound & tools chunk)

A section with the last entries (time, kind, message), *Copy report*, *Clear log* (with Undo, like every reversible change), and one
sentence saying that it stays on this device and nothing is sent. Phone, tablet, desktop and TV sizes, axe, a TV remote.

### 5. Routing the swallowed catches

`note(kind)` (start-up, a few lines) returns `(error) => void` that records lazily. The sites that hide a failed save (the quiet writes of
`write.ts` that fail for a real reason, not a refusal), a decode (`convert`, `analyze`, `loudness`), a worker (waveform, chapters,
listening) or a `play()` get `.catch(note('save'))` and so on. The library's skipped rows and playlists (F1's counts, no names) become a
`library` entry.

## Stages (each ends verified and pushed; F2 is ticked after stage 3)

1. **Playback recovery.** The experiments first (real garbage files without the stub; the hand-over in all three modes), then
   `faults.ts`, `pickTrack(skip)`, the wiring, the `lossless.spec.ts` test that asserts attempts stop, and experiment C as a regression
   test in every transition mode. Unit tests, seeded fuzzing of random streams of events against the faults object.
2. **The log.** `capture.ts`, `log.ts`, the redaction, Diagnostics, the routing of the swallowed catches; fuzzing of the bounds and the
   redaction (hostile titles and file names never reach a report).
3. **The root boundary.** `RootBoundary`, *Start fresh* and the safe start in the hydration code, e2e for a render error (a stub that makes
   a start-up component throw), axe, README, a mutation pass in a scratch copy, the full suites.

## Test plan

- Unit: `faults` (stale and duplicate events, once per source, progress resets the streak, forget on a request by hand, an idle deck's
  failure, the cap), `pickTrack` with `skip` (all modes, all skipped, one left), `redact` (table plus fuzz), the log (bounds, repeat
  count, persistence and a damaged stored value, kinds), `note`, the report text, `RootBoundary` (jsdom: renders the recovery, the three
  buttons call their ports), the safe start.
- E2E: experiment C in Off, Gapless and Crossfade (the unplayable file is skipped, named in a notice, and the next track plays); a queue
  of unplayable files with repeat on makes no attempts after the notice; a render error shows the recovery screen and *Reload* restores
  the app; *Start fresh* keeps the library and the playlists and forgets the rest; Diagnostics lists an error and the copied report
  contains none of the file names the test used; axe on the screen and the section.

## Risks and how they are covered

| Risk | Cover |
|---|---|
| A skip marks a track bad for a transient fault and it is never tried again | the mark lives for the session only, and asking for the track by hand forgets it |
| The boundary itself throws | it uses no icons, overlays or lazy code, only elements; its own test renders it with a throwing child and a throwing log |
| Redaction misses something | structured entries first, a fuzz test with hostile names, and the report never includes settings or library data |
| Start-up budget | measured at each stage; the log and its UI are lazy, the capture and the boundary are small and measured on their own |
| *Start fresh* destroys something the person wanted | the copy says exactly what goes; the library, playlists and backups are not touched |

## Calls made without asking

- A mark of unplayable is kept for the session, in memory, not stored: a file that fails today may play after an update of the browser.
- *Start fresh* also forgets the settings, because a stored setting is the likeliest cause of a crash on every start that the repaired
  library cannot be.
- The log is stored in `localStorage` (small, readable at start-up before IndexedDB), not in the database.

## As built

### Stage 1: playback recovery

Built as designed, with these differences found by checking it against the browser and by breaking it on purpose.

- **The hypotheses were checked with real garbage files, no stub.** A probe that logs every media event showed what a real browser does: `play()` is rejected with `NotSupportedError` and an `error` event follows; `paused` stays `false` and no `pause` event is fired. So `onPlay` resetting the streak (the old code) did make the cap never hold, which is the 428 attempts in 6 s. It also showed a bug nobody had named: on the old build a first track that could not be read while it was only being made ready (paused, at start-up) set the *next* track playing by itself. The new code keeps the intent of the load (`playIntent`), so the next track is made ready paused as well; a Pause pressed in the middle of a chain is respected too.
- **`lib/faults.ts` is as designed** (`attach`, `detach`, `fail`, `markBad`, `isUnplayable`, `markNoPreload`, `canPreload`, `forget`, `noteFailure`, `progress`; `unplayable` is one live set that `pickTrack({ skip })` reads). `hasFailed` was written and deleted: nothing could reach it.
- **A track is forgotten by being loaded.** `load()` forgets the mark of the track it loads, so one rule covers a click on a row, *Play* on an album page, the play button, a track taken from Up Next, Previous: asking for a track is a fresh try. (The first version had a `forget` at six entry points and a break pass showed two of them were not tested; one rule is shorter and tested once.) `play`, `playFrom` and the play button still ask whether the track *had* failed, to load it again instead of starting an element in an error state.
- **A track that cannot be played leaves Up Next** (`giveUp`). The design only said the queue would go past it; leaving the entry in the list showed a track that would never play.
- **The streak ends when the file can be read** (`loadedmetadata`), which also covers a track that is only made ready. A second reset when the playhead moved was in the first version and a break showed nothing needed it, so it went. The cap on the length of a chain (`streak > queue length`) went too: every failing track is given up on, so each failure leaves one track fewer and `pickTrack` ends the chain itself.
- **An error on the idle deck is handled when it happens**, not when the hand-over reaches it: the track is left out of the lining up (`markNoPreload`), the pending pick is dropped, the deck is emptied, and a file that is not WAV or FLAC is given up on with the notice at once, so a gapless or crossfade hand-over goes straight to the track after it and the screen never shows the bad file (checked by recording every document title). A WAV or FLAC that only failed to preload is *not* given up on: it is decoded when its turn comes. A first version also caught a `NotSupportedError` from the hand-over's own `play()`; the idle deck's `error` event already covers it, and a break that removed the `error` handler showed the second path was hiding the first, so it went.
- **Tests.** Unit tests for `faults` and `pickTrack({ skip })`, with a seeded fuzz test of random streams of events against a plain model; e2e tests (`recovery.spec.ts`) for experiment C in all three transition modes, a queue with nothing playable (no more attempts after the notice), a run of bad files (named once, counted), a failure that passes, Up Next, *Play* on an album page, the play button and the row, a FLAC that cannot be lined up, and an error some seconds into a file; `lossless.spec.ts` asserts that attempts stop. The relevant ones are red on the build before stage 1.
- **A mutation pass in a scratch copy** (39 breaks of `faults`, `queue` and the wiring, then a second round after the survivors were turned into tests or deleted). The first round killed 25 of 39: the 14 survivors were redundant code (removed) and missing tests (written).

### Stage 2: the error log

Built as designed (`lib/diagnostics/`: `capture.ts` in the first load, `log.ts`, `redact.ts`, `report.ts` and `types.ts` as lazy code, `DiagnosticsSection` inside the Sound & tools chunk), with these particulars.

- **What reaches the log.** `note(kind)` is what a `.catch()` uses instead of swallowing a failure, and the sites are the ones a person would want to know of: every database failure of a library write (the writer's new `report` option, so the automatic writes that fail quietly, which F1 left to this stage, are in the log whether or not anybody waits for the answer), the audio graph that could not be built, the loudness measuring and the probes of a file nobody could read, the waveform and chapter services, the decode worker's `onerror`, the offline start, and in the player the file the browser rejected (`play`, as `MediaError` with its code and what the browser said), a lossless file the app's own decoder could not read (`decode`), the saved library (`library`: unreadable, or damaged items as two counts and no names) and settings the device had no room to keep (`save`). What is an answer and not a failure is not logged: a format the probes do not know, a cancelled measuring, a lossless file the browser cannot play and the app decodes, and a plain bad file is one `play` entry, not also the decoder fallback's "not a WAV or FLAC file" (an e2e assertion on the kinds says so).
- **The cleaning** (`redact.ts`) takes out, in this order, quoted text (`<text>`; an apostrophe inside or at the end of a word is not a quote), links (`<url>`), Windows paths to the end of the line and other paths (`<path>`), anything that ends like a music, text or picture file (`<file>`), e-mail addresses, long codes and hashes (`<id>`) and numbers of six digits or more (`<n>`). It errs towards removing too much and is fuzzed with hostile titles in every position of a message. A stack is kept only as `function (file.js:line:column)`, never a link, and not at all for frames of browser extensions.
- **The store** is `localStorage['wl.diagnostics']`: at most 50 entries and 24 kB, the same failure in a row one entry with a count, a damaged value an empty log, other windows' entries merged in before each write, and what a full store cannot take kept in memory and written with the next entry that can be.
- **Found by the first run of the new e2e spec.** Every test of the log saw a `worker` entry nobody had asked for: `OfflineController.start` threw *Cannot read properties of undefined* when `register()` resolved to nothing, as it does in a browser told to leave workers out (the suite runs with `serviceWorkers: 'block'`), and the `.catch(() => {})` in `main.tsx` had hidden it since E4. A registration of nothing is now *blocked*, with a unit test. It is the kind of thing the log is for.

### Stage 3: the root boundary, the sound and the fresh start

- **`RootBoundary`** is as designed: plain elements, no icons, dialogs, lazy panel, player or database; *Reload*, *Start fresh…* (asks once more in place, then reloads) and *Copy details* (the clipboard, or a box to select from when the browser refuses). axe found a gap in the first version: the confirmation paragraph of *Start fresh* sat outside every landmark, so the screen is now a `<main>`.
- **The sound has to stay stopped.** The first version paused the elements when the screen appeared, and the e2e test that plays a track and then breaks the page found the sound still playing: a WAV or FLAC starts only after an asynchronous check or decode, which the unmounted player's pending work finishes a moment after the pause. `silenceAudio` therefore pauses every element an engine made and replaces its `play` with a rejection (`AbortError`), for good; only a reload brings the sound back. It also takes the player off the lock screen and notification shade.
- **Start fresh** (`safestart.ts`) forgets the `wl-*` and `wl.*` keys of `localStorage` except the log and sets a flag in `sessionStorage`, which the next page load takes (once) at module load. The hydration then leaves out the resume point and the saved Up Next; a restored backup still waiting for its files is never forgotten that way, because it is the person's own data and the effects that save state would otherwise overwrite it. The music, the playlists and the per-track curves are never touched. `startFresh(reload)` runs the three steps in an order that cannot get stuck: a browser that refuses storage throws when the settings are reached, and the first version of the screen would never have got as far as the reload.
- **The lazy-panel boundary** (`Deferred` in `lazy.tsx`) said *Could not load X. Check your connection.* for any error. It now tells a download that failed (Chromium, Firefox and Safari word it differently; a bundler's `ChunkLoadError`) from a panel whose code arrived and broke (*Something went wrong in X.*), and keeps both in the log. `Deferred` also takes a `fallback` that holds the place of a panel while it loads.
- **The start-up budget.** Stages 2 and 3 cost 1.9 kB gzipped in the first load (the boundary 1.1, the capture and the call sites the rest), which put it at 125.3 of 125.0. The visualizer, a canvas drawn only on the stage and in the phone sheet, became a lazy chunk (`LazyVisualizer`; a box of its size holds its place, so the page does not jump): initial JS 124.7 of 125.0 kB. Next candidates: `PlaylistMenu` and the upgrade code (`lib/upgrade.ts`).

### Proof

- Unit tests: `redact` (a table and fuzzing with hostile titles), the log (bounds, repeats, persistence, a damaged or full store, other windows), the capture, the report, `safestart`, `RootBoundary` and the lazy-panel boundary in jsdom, `silenceAudio`, `mediaFault`, and the reports of the writer and of the waveform, chapters, loudness and analysis code (a cancellation and a stored reason are not reported).
- E2E: `boundary.spec.ts` (9: the screen and *Reload*, axe at desktop and phone width, the keyboard order, the sound stopped behind it and the lock screen cleared, the copied details without any name, the clipboard refused, listed in Diagnostics afterwards, *Start fresh* keeping the library and the playlists and forgetting the settings, the position and the queue, and backing out of it), `diagnostics.spec.ts` (17: ordinary listening leaves the log empty, an error and a rejection with the names taken out and still there after a reload, the empty state, a count, the copied report, a refused clipboard, clearing and Undo, a full device, a file that could not be played, a quiet save that failed, settings with no room, a library that could not be read, damaged items as a count, and the section at phone, tablet, desktop and TV sizes with axe) and the log assertion in `recovery.spec.ts`.
- **A mutation pass in scratch copies of the tree** (so that no break could be left behind): 80 deliberate breaks of stages 2 and 3, 51 of the pure code (the cleaning, the log, the capture, the report, the fresh start, the recovery screen, the writer's reporting) and 29 of the wiring (the player's calls into the log, the fresh start in the hydration, the root boundary, the silencing of the sound, the lazy-panel boundary, the offline start, the services' reports). 76 were caught at once. The four that were not each said something: a second replacement of identifiers that `LONG_TOKEN_RE` already covers (a UUID is 36 characters of its class; deleted), a decoded copy that fails to play and a lossless file nobody can decode (neither was in any test's view: an e2e test each, with a real FLAC marker over a broken body for the second), and a bundler's `ChunkLoadError` name that a test hid by also putting *Loading chunk* in its message (the message now says nothing, so only the name can be what is recognised). All four are caught now, and a first attempt to prove one of them printed *killed* with no test named, which was a pattern that matched no test: a kill needs the failing test's name to count.
- **Numbers.** 3,396 unit tests (156 files), 562 e2e tests and the 26 desktop smoke tests, all passing; coverage thresholds pass; initial JS 124.7 of 125.0 kB (0.3 kB of room: the next milestone that needs start-up code makes its own room first).
