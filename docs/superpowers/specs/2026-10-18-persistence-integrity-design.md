# Persistence integrity (ROADMAP F1)

Status: design for an autonomous build, 2026-10-18. Nobody was asked; every choice below is a call made by the builder from the
code as it stands (checked, not assumed) and from four experiments that failed against the production build. If a call is wrong
it is cheap to change: the parts are separate modules.

## Why

A person's library is the one thing in Wavelocal that cannot be re-created by reloading. The audit of 2026-10-18 ran throwaway
Playwright experiments against `dist/` (they pass when the behaviour is right and fail when the defect is real); four failed:

- **A. A failed read at start-up wipes what was saved.** The first `getAll` of the tracks threw once. `usePlayer` swallowed it
  (`catch {}`), still set `hydrated`, and the effects that write the in-memory state to the database switched on:
  `order`, `playlists` and `upNext` were stored as `[]`, the library showed 0 rows. The audio stays in the database, but its order and
  every playlist are gone.
- **D. Saves die silently when the connection closes.** `idb.ts` caches one connection for ever and handles neither `close` nor
  `versionchange`. After the connection was closed under a running window, `db.transaction()` threw `InvalidStateError` for every
  later write, each write ended in `.catch(() => {})`, and a file imported next was listed and never stored, until a reload.
- **E. Two windows overwrite each other.** Window two made a playlist after window one had made another: the stored list was
  `["Two"]`.
- **Unvalidated reads.** `playlists` and `resume` come out of the database as they are (`Array.isArray` is the only check) and rows are
  trusted: one damaged entry throws while rendering, and since it is stored, on every start.

One suspicion was **disproved** (experiment B): putting a record back with its audio costs 11 ms for 300 MB, because Chromium shares
the stored blob. Play counts, gains and lyrics need no redesign.

## Goals

1. A window that could not read the saved library **never writes over it**.
2. Whatever comes out of the database is **validated** before the page sees it; a damaged entry is skipped and counted, never fatal.
3. A failed save is **said once, with advice**, **retried**, and visible later in Sound & tools → Storage; nothing fails silently.
4. A closed connection is **reopened**; a connection another context needs is **let go**.
5. **One window writes** (the newest); an older one is told the first time a change of its own would be dropped, and can take over.
6. No IndexedDB version change, no new object store, no change to what is stored (the keys, shapes and the order of a healthy library stay as they are).

## Non-goals

- No live sync between windows (a change made in one is not pushed to the other), no merging of two windows' edits.
- No recovery of data that is already gone, no repair UI for the database, no export-on-failure (the JSON backup exists).
- No change to the derived caches (`peaks:`, `chapters:`, `listen:`, `heard:`): they already refuse to write what they could not read.

## Anti-goals (would make this a failure even if it "works")

- A slower start: the library must show as fast as before (the reads and the code of the new chunk are fetched together).
- A window that cannot be used at all because a lock misfired: a plain reload, a service-worker update reload and the second window of
  the offline test must all behave as they do today.
- More than the start-up budget allows: the initial JS is 124.6 of 125.0 kB. The gate and the guarded writes are start-up code and
  must be tiny; reading, validating, retrying and explaining are lazy chunks, fetched while the reads run.
- Losing data on the *healthy* path: for a library that reads cleanly, the state after hydration must equal what the old code made.

## Facts the design rests on (verified in the code)

- `usePlayer.ts` hydrates once in an effect: `Promise.all` of `getAllTracks` and six `getMeta` reads; any rejection goes to `catch {}`;
  `finally` calls `setHydrated(true)`. Five persistence effects (`order`, `playlists`, `trackEq`, `pendingRestore`, `upNext`) write whole values
  when `hydrated` is true, and `resume` is written on pause, every 5 s while playing and on `pagehide`.
- Of the stored values only `trackEq` (`normalizeTrackEq`), `upNext` (`keepKnown`) and the pending restore (`normalizePending`) are validated;
  rows go straight into `buildTrack` (which repairs the analysis fields through `normalizeMeta` but trusts `id`, `file`, `title`, `artist`, `album`, `lyrics`).
- `idb.ts` caches `dbPromise`, clears it only if opening failed, and sets no event handler on the connection.
- The overlay store (`overlays.ts`) can show a dialog or a toast with an action from anywhere, including start-up code.
- `e2e/offline.spec.ts` ("a window that was open when another one updated is told, and can follow") opens two windows in one browser
  context on purpose, so an older window must stay usable. `share.spec.ts` and `backup.spec.ts` use separate contexts (separate lock spaces).
- Web Locks (`navigator.locks`) exist in Chromium, so in the Android WebView and Electron too. `request(name, { steal: true }, cb)` is granted at once
  and rejects the previous holder's `request()` promise with `AbortError`.

## Design

### 1. The write gate (`lib/persist/gate.ts`, start-up code)

One object says whether this window may write the library:

| mode | meaning | writes |
|---|---|---|
| `loading` | reading the saved library | wait for the answer |
| `open` | read cleanly, and this window holds the lock | yes |
| `memory` | could not read it (`unreadable`) or the browser keeps nothing (`unavailable`) | no |
| `taken` | another window took the lock | no |

It is an external store (`subscribe` / `snapshot`, like `overlays`) so the Storage panel shows it. It also holds the keys whose
latest save failed. `noteDropped(key)` is called when a write is refused in `memory` or `taken`; the first one per mode asks the lazy
`notices` module to explain (below). A write refused while `loading` is not a drop: it waits (`settled`).

`claimWriter()` takes the lock before anything is read: `navigator.locks.request('wavelocal-library', { steal: true }, hold)` where `hold`
resolves the claim and returns a promise that never settles, so the lock lasts as long as the page. If that request later rejects after it
was granted, the lock was stolen: `take()`. A browser without Web Locks, or one that answers nothing in two seconds, simply goes on (as today).
Because the newest window steals, a reload never races the old document, and a service-worker update reload needs no care.

### 2. Reading (`lib/persist/load.ts` + `hydrate.ts`, lazy)

`loadLibrary(reader)` reads the seven values together, **all or nothing**, and tries three times (now, +250 ms, +800 ms) before it gives up; a browser
without IndexedDB (or a `SecurityError`) is `unavailable` at once. The answer is `{ ok: true, library }` or `{ ok: false, reason }`.

`hydrateLibrary(raw)` is pure and returns what the hook applies:
- rows → `normalizeRow` (an `id`, a `Blob` file; everything else is repaired: text fields to text, numbers to finite non-negative, lyrics to a well-formed
  value or null, the key rebuilt from the file); a row that cannot be played at all is **skipped and counted but never deleted**;
- `order` → ids that exist, once each, then the rows not mentioned (as today, minus duplicates);
- `playlists` → entries with a text `id` (unique), a cleaned name and text `trackIds` (an entry with extra fields keeps them); anything else is dropped and counted;
- `resume` → `{ id, time }` with a finite time, or null; `trackEq`, `upNext` as before, against the ids that survived.

For a healthy library the output is exactly what the old inline code produced (pinned by a test that runs both).

### 3. Writing (`lib/persist/write.ts`, start-up code)

The hook stops calling `db.setMeta` / `putTracks` / `patchTracks` / `deleteTrack` / `clearTracks` directly:

- `saveMeta(key, value, { quiet })`, `removeTrack(id)`, `clearTracks()` run when the gate is open. A refused one is dropped (`noteDropped` unless `quiet`: the resume point and play counts are
  automatic and never worth a dialog). A failed one calls the lazy `failures` module, but **only if it is still the latest write of its key** (a newer value supersedes it).
- `saveTracks(records)` and `patchTracks(map)` return a promise that **rejects**: with a `NotSavingError` when refused, with the database's error when it fails. The import and the tag editor already have
  failure messages and use them; best-effort callers (play counts, gain, lyrics) ignore it as before.

`failures` (lazy): the first failure of an episode shows one toast with the advice (`describeSaveFailure`: out of space has its own text) and a *Try again*; each key is retried with backoff (1 s doubling to 30 s)
with its **latest** value only; when the last failing key is saved it says *Saving works again*. *Try again* retries now. State shows in the gate.

### 4. The connection (`lib/idb.ts`)

`onclose` (the browser closed it) drops the cached connection, so the next call opens a new one; `onversionchange` closes it and drops it (another context wants to upgrade or delete the database, and an open window must not hold it up).
A failed open was already forgotten. The version stays 1.

### 5. One writing window

The window that claims last writes. An older window is `taken`: it keeps playing and browsing, its own *structural* changes (playlists, the queue, the library, removing, clearing) are refused,
and the first refusal shows one dialog: *Wavelocal is open in another window … Changes made here are not saved. Use this window instead?* (*Use this window* steals the lock back and reloads; *Not now* leaves it;
the Storage panel keeps saying so). Automatic writes (the resume point, play counts, gains) are dropped quietly. Adding music in a `taken` window is refused the same way: it would be listed and lost.

`memory` windows say it at once, because an empty library needs explaining: *Wavelocal could not open the library saved on this device, so it is not saving anything, to protect what is there. Your files are untouched. Reload to try again.*
(`unavailable`: *This browser does not let Wavelocal keep anything on this device. Your library is gone when this tab closes.*). Import still works in memory, with the same words when it is attempted.

### 6. Start-up budget

Start-up code: `gate.ts` (the store, the claim, the error class), `write.ts`, the `idb.ts` handlers, and a dynamic `import()` in the hook; `hydrate` / `load` / `failures` / `notices` / the Storage row are lazy and the first two are fetched
while the reads run (`Promise.all`). The inline hydration code leaves the hook. If the total does not fit in what is left (0.4 kB), room is made first by moving code that is not needed at first paint into lazy chunks
(candidates, measured with a source map of the start-up chunk: `ImportStatus` 2.0 kB raw, `Lyrics` 2.1, `PlaylistMenu` 1.2, the library `upgrade` 1.3 and `importer` 1.6), and the budget is not raised.

## Stages (each ends verified and pushed; F1 is ticked after stage 3)

1. **Reading and the gate.** `hydrate`, `load`, the gate, `write`, the hook, `idb.ts` recovery; the wipe (A) and the dead connection (D) fixed; damaged data survived. Unit tests with a faulty in-memory database, seeded fuzzing of `hydrateLibrary`.
2. **Failing saves.** `failures`, the Storage row, the import and tag-editor messages for refused saves.
3. **One writing window.** The claim, `taken`, the dialog and *Use this window*; experiment E as a regression test. Then polish and proof: README, a mutation pass, the full suites.

## Test plan

- Unit: `hydrate` (each repair, order and duplicates, equality with the old output for a healthy library, 3,000-seed fuzz that nothing throws and every output is well formed), `load` (retries, all-or-nothing, `unavailable`, no write on failure),
  `gate` (modes, `settled`, refusal counts, `take` before and after hydration, a fake `LockManager` with `steal`), `write` (superseded failures are ignored, refusals reject, quiet drops), `failures` (backoff, latest value only, one toast per episode, recovery), `idb` (a fake factory: `onclose` and `onversionchange` reopen).
- E2E (`e2e/integrity.spec.ts`, from the experiments): a failed first read is retried and nothing is lost; reads that keep failing leave the stored order, playlists and queue untouched and say so; a damaged stored playlist and a row without a file do not blank the page;
  a connection closed under the window is reopened and the next import is stored; a save that fails (the quota stub of `storage.spec.ts`) says so once, retries, and says it works again; the older of two windows is told and can take over; axe on the dialogs and the Storage row.

## Risks and how they are covered

| Risk | Cover |
|---|---|
| The lock misfires and a window cannot save | the newest window steals (no wait, no race with a closing page); a timeout lets a browser that never answers go on; the whole e2e suite reloads constantly and would show it |
| Validation changes what a healthy library looks like | equality test against the old inline code; the 10,000-track performance spec |
| Start-up budget | measured after each stage; room made by lazy chunks, never by raising the limit |
| A refused write hides data the person thinks was saved | refusal is always followed by words (dialog, toast, Storage row); a test per mode |
| Retry writes an old value over a newer one | only the latest write of a key can retry; a test with a failure that arrives after a newer write |

## Calls made without asking

- Reads are all-or-nothing with three tries, and a failed read means a window that saves nothing: protecting what is stored matters more than showing a partial library.
- The newest window writes; the older one is not blocked, because the offline update flow opens windows side by side on purpose.
- Skipped rows stay in the database (the audio is the person's); damaged playlist entries are dropped when the cleaned list is next written (they are not recoverable data).
