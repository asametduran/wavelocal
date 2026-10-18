# Saving files on Android, and the Android shell (ROADMAP F3)

Status: design for an autonomous build, 2026-10-18. Nobody was asked; every choice below is a call made by the builder from the code
as it stands and from the sources of the Capacitor runtime and plugins in `node_modules` (read, not remembered). What cannot be tried
without an Android SDK, a device or an emulator is marked **(device)**; the APK workflow compiles the native side and proves nothing
more. The *As built* section at the end records what turned out.

## Why

Three places save a file by clicking an invisible `blob:` link: the playlist export (`lib/download.ts`, used by `playlistio.ts`), the
JSON backup (`BackupSection.tsx`, its own copy of the same code) and the tag editor's *Download copy* (`TagEditor.tsx`). A browser and
the Electron shell take that as a download. The Capacitor WebView of the Android app does not: it has no download handler, so the
click does nothing **(device)**, and `playlistio.ts` then says *Exported 12 tracks as list.m3u8*. That is a false statement about the
person's data, and the backup, whose whole point is to be kept somewhere, fails without a word.

Found while reading the Android runtime for this (verified in the sources, see *Facts*): **the hardware Back button closes the whole
app.** Capacitor's Android core has no Back handling at all (it lives in `@capacitor/app`, which the project does not have), so
the activity takes Android's default and finishes. Every sheet, dialog and page of the app is a history entry that Back is meant to
close (E2, E3: *Back, Esc and a phone's Back button close a page*); on the Android app Back ends the app instead, and the music with it.

## Goals

1. **One `saveFile(blob, name)`** for the three sites. On the web and in Electron it is the download link as before, with the same
   words. On Android it writes the file in chunks to the app's cache directory and hands it to the system share sheet, which is how a
   person keeps it (Drive, Files, mail, a messenger).
2. **Honest words.** *Shared*, *not saved: the share sheet was closed*, *no room left on this device*, *another share sheet is still
   open*, and a plain failure that points at Diagnostics. Never *Exported* for something that did not happen.
3. **No plugin code in the web bundle.** The native saver is a lazy chunk that only the Android app fetches, reaching the plugins through
   `registerPlugin`. The plugins are dependencies so that `cap sync` wires the native side.
4. **A fake bridge** so that unit and e2e tests run the real `@capacitor/core` `registerPlugin` path against scripted native answers.
5. **Hardware Back works** on Android: it goes back through the app's history layers (closing a sheet, a dialog, a page), and at the root
   it minimizes the app, so that the music goes on.
6. **An audit of the Android shell** (back button, status bar, insets, permissions, files) recorded here, with what could not be tried.

## Non-goals

- No native code of our own. No Storage Access Framework picker, no media notification, no foreground service (parking lot).
- No new permission: files go to the app's own cache directory and out through the share sheet, which needs none.
- Nothing changes for the web, the PWA or Electron, except that the two sites that said nothing now say what happened.
- No save to a public folder (`Directory.Documents`): on Android 10 and newer the app cannot write there without a legacy flag, and on 11
  and newer only to what it created.

## Anti-goals (a failure even if it "works")

- Plugin JavaScript, or `@capacitor/core`, in the first load or in a lazy chunk the web app ever fetches.
- A whole file in memory: a *Download copy* of a track can be hundreds of megabytes. It is read and written in slices.
- A save that reports success before the share sheet has had its say, or that leaves a failed half-written file behind.
- A new permission, provider or service sneaking in with a plugin upgrade: a test pins that none of the plugins we depend on adds any.

## Facts the design rests on (verified in the sources)

- **The app already has a FileProvider.** `android/app/src/main/AndroidManifest.xml` declares `androidx.core.content.FileProvider` with
  authority `${applicationId}.fileprovider`, and `res/xml/file_paths.xml` has `<cache-path name="my_cache_images" path="." />` and an
  `external-path`. The Share plugin builds its `content://` URI with exactly that authority, from a `file:` URL under the cache
  directory. Both plugins' own manifests are empty (no permission, no provider).
- **`@capacitor/share` 8.0.3** (`SharePlugin.java`): `share({ title, files: [file URL], dialogTitle })` takes `file:` URLs only (anything
  else: `"only file urls are supported"`), types them by extension and starts a chooser. The promise resolves with `{ activityType }` when
  the chooser returns, rejects `"Share canceled"` when it was dismissed (`RESULT_CANCELED` while the app was not stopped), and
  `"Can't share while sharing is in progress"` for a second call. `canShare` always says yes on Android.
- **`@capacitor/filesystem` 8.1.5**: `writeFile({ path, data, directory: 'CACHE', recursive })` answers `{ uri }` (a `file:` URL);
  `appendFile`, `deleteFile`, `readdir` (`{ files: [{ name, type }] }`) take the same `path` and `directory`. Binary data is base64 with
  no `encoding`. The cache directory "can be deleted in cases of low memory", which suits a file that only waits for the share sheet.
- **How `registerPlugin` works** (`@capacitor/core` 8, `dist/index.js`): it reuses a `window.Capacitor` that already exists, reads
  `window.Capacitor.PluginHeaders` and, for a plugin the native side lists, sends each call through `Capacitor.nativePromise(plugin,
  method, options)` (or `nativeCallback` for listeners). A page counts as Android when `window.androidBridge` exists. The injected
  `native-bridge.js` defines `isNativePlatform` (true), `nativePromise` and `nativeCallback` before any page script runs, so the
  existing `isNativeApp()` test (`window.Capacitor?.isNativePlatform?.()`) is sound on a device.
- **Back.** `grep` over `@capacitor/android` finds no `OnBackPressedCallback`, `onBackPressed` or `goBack` outside a Cordova mock; the
  default action named in `native-bridge.js` is the `App` plugin's. `@capacitor/app` 8.1.2 registers an `OnBackPressedCallback`: with no
  JavaScript listener it calls `webView.goBack()` when `canGoBack()`, and otherwise does nothing; with a listener it notifies it with
  `{ canGoBack }` and does nothing else. It also has `minimizeApp()` and `exitApp()`.
- **Insets.** Capacitor 8's `SystemBars` plugin (core) handles insets for `insetsHandling: "css"` (the default) when the page has
  `viewport-fit=cover`, which `index.html` has; the app's `.pt-safe` and `.pb-safe` read `env(safe-area-inset-top|bottom)`.
- **Permissions.** `INTERNET` only, pinned by `scripts/android-manifest.test.ts` together with `allowBackup=false` and no cleartext.
- `android/` is committed, and `npx cap sync android` needs no SDK: it rewrites `capacitor.settings.gradle` and `app/capacitor.build.gradle`.
- The initial JS is 124.7 of 125.0 kB. Everything here is lazy except the dispatcher's few lines.

## Design

### 1. `saveFile` (`lib/savefile/`)

- `index.ts`: `saveFile(blob, fileName): Promise<SaveOutcome>`, never throws. Not Android: `downloadBlob` and `{ kind: 'downloaded' }`. Android: `import('./plugins')`
  and its saver; a chunk that cannot be fetched or a plugin that is missing is `{ kind: 'failed', why: 'unavailable' }`. Every failure
  goes to the error log (`note('save')`, F2). `saveWords(outcome, fileName)` is the one place that says it: `null` for a download (each
  caller keeps its own words), otherwise the sentences above.
- `native.ts`: `createNativeSaver({ files, share, encode, chunkBytes })`, pure, with the plugins as ports. It clears what an earlier save
  left in `wavelocal-share/` (the share sheet's target may still be reading the last file when the promise resolves, so a file is
  removed by the *next* save, never by its own), writes the blob in slices of 768 KiB (a multiple of three, so that no slice but the
  last carries base64 padding): the first with `writeFile` (`recursive`, which creates the folder), the rest with `appendFile`, then
  shares the `file:` URL. A write that fails deletes the partial file. Errors are classified (`full`, `busy`, `other`) from what the
  bridge says; `"Share canceled"` is `cancelled`, not a failure.
- `name.ts`: `safeFileName`: separators, control characters and Windows-reserved punctuation become `_`, no leading or trailing dots or
  spaces, at most 120 UTF-16 units without cutting a surrogate pair or the extension, never empty.
- `chunks.ts`: base64 of a slice through `FileReader.readAsDataURL` (native, off the JS heap), with the data-URL prefix removed.
- `plugins.ts`: the only file that imports `@capacitor/core`: `registerPlugin<FilesPort>('Filesystem')` and `registerPlugin<SharePort>('Share')`
  (the port interfaces are ours, so no plugin enum or runtime comes along; the plugin packages are in `package.json` for `cap sync`).

The three sites become: `exportPlaylist` (now async; *Exported N tracks as X* after a download, the saver's words otherwise), the backup
(a failure shows in the panel where errors already show, anything else as a toast) and the tag editor's copy (same).

### 2. Hardware Back (`lib/androidshell.ts`)

Add `@capacitor/app` (native default: back through the WebView's history, which is where every layer lives) and, only in the Android
app, a lazy `backButton` listener: `canGoBack` goes back with `history.back()`, otherwise `minimizeApp()`, so that Back at the root
leaves the music playing instead of ending the activity or being swallowed. It starts from `main.tsx` after load, behind
`isNativeApp()`, so the web never fetches it. `handleBack` is a pure function; the listener is a few lines.

### 3. The audit, and what guards it

A section of the *As built* record. Guards that can run here: `scripts/android-manifest.test.ts` also pins the FileProvider and its
`cache-path`, that no Capacitor plugin we depend on declares a permission, provider, receiver or service of its own, and that every
`@capacitor/*` plugin in `package.json` is wired in `capacitor.settings.gradle` (a forgotten `cap sync` fails a unit test, not the APK).

## Stages (each verified; the whole milestone is pushed after stage 3)

1. **Saving files.** `platform.ts`, `lib/savefile/`, the three sites, the fake bridge (`e2e/android.ts`), unit and e2e tests, the
   dependencies and the synced Gradle files.
2. **Back.** `@capacitor/app`, `androidshell.ts`, the fake bridge's listener, unit and e2e tests, the manifest guards.
3. **Proof and record.** README, the audit, a mutation pass in a scratch copy, the full suites, ROADMAP, the push; the APK workflow is the check of the native side.

## Test plan

- Unit: `safeFileName` (table and seeded fuzz: never empty, no separator, bounded, extension kept, no half surrogate pair);
  `createNativeSaver` with fake ports (the bytes of what was written equal the blob at sizes 0, 1, a chunk minus one, exactly a chunk, a
  chunk plus one, several chunks; the first call is `writeFile` with `recursive`, the others `appendFile`; old files cleared and a
  failing clear ignored; a failed write deletes the partial file and nothing is shared; every classification; cancel; busy; a
  `writeFile` with no `uri`); the dispatcher with the platform, `downloadBlob` and the lazy module mocked; `saveWords` for every
  outcome; `handleBack`; the manifest guards.
- E2E (`e2e/savefile.spec.ts`, a fake Android that scripts `PluginHeaders` and `nativePromise` under the real `@capacitor/core`): a
  playlist, the backup and a track copy are written as the exact bytes expected and shared, with the words a person sees; a cancelled
  sheet, a full device and a share that is already open each say so and leave no file behind; the web still downloads (the existing
  specs); Back closes a sheet and a dialog, and at the root asks the app to minimize; axe on the messages.

## Risks and how they are covered

| Risk | Cover |
|---|---|
| The bridge limits the size of a message, or a slice is too big for it | 768 KiB slices (1 MiB of base64); never a whole file **(device)** |
| `registerPlugin` behaves differently in the real WebView than under the fake | the fake reproduces what `native-bridge.js` provides (`androidBridge`, `isNativePlatform`, `PluginHeaders`, `nativePromise`/`nativeCallback`), read from its source; the APK build compiles the native side **(device)** |
| A target app reads the shared file after the promise resolved | a file is only removed by the next save |
| A plugin upgrade adds a permission | a unit test reads each plugin's manifest |
| The share sheet is dismissed and the person thinks the backup is kept | *Not saved: the share sheet was closed*, as a toast and, for the backup, in the panel |
| Start-up budget | the dispatcher and the listener starter are a few lines; the measured size is recorded below |

## Calls made without asking

- A save on Android goes through the share sheet, not into *Downloads*: that is the only way that needs no permission.
- The saved file waits in the cache until the next save, not until the share sheet resolves.
- Back at the root minimizes instead of exiting: the app is a music player, and exiting ends the music.
- `@capacitor/app` is added for Back even though its JavaScript is only a listener: the native half is what makes Back work at all.

## As built

Stage log: 3 of 3 done. The first stage was written in a run that the usage limit cut off before its first verification; the next run
found it uncommitted in the tree, verified it (typecheck, unit, build, the new e2e spec: it found two failing tests whose fixture was
too small to need more than one slice, and one existing unit test still calling the now-async export), and the three stages were
verified and pushed together.

### What differs from the design above

- **`safeFileName` counts UTF-8 bytes, not UTF-16 units**: at most 200 bytes (a component of an Android path may hold 255), cut at a
  whole character, with a short extension kept (a longer "extension" is a sentence with a dot in it) and an extension that is all there
  is (`.m3u8`) kept after the fallback `file`, because the share sheet types a file by its extension.
- **The Back button starts from `afterload.ts`, not from `main.tsx` directly.** The start-up chunk had 0.2 kB of room, so `main.tsx`
  still makes one dynamic import after `load`, now of `lib/afterload` (a lazy chunk) instead of `lib/offline/instance`. `afterLoad()` starts
  the offline copy as before and, behind `isNativeApp()`, imports `androidshell` (and with it `@capacitor/core`), so the web never
  fetches either. Initial JS: 124.8 of 125.0 kB (it was 124.7).
- **`@capacitor/core` has a chunk of its own** (`capacitor-*.js`, a named group in `vite.config.js`), shared by the saver
  (`plugins-*.js`) and the shell (`androidshell-*.js`). The e2e tests tell the web from the Android app by which of the three were
  fetched, and that `androidBridge` (how core tells Android) is in that one file and in no first-load file.
- **`isNativeApp()` cannot throw** (a `Capacitor` that is not a function, or one that throws, is not the app), so that `saveFile`'s
  "never throws" holds on a page that has some other `Capacitor`.
- **A copy of a track shows *Preparing…*** (`aria-disabled`, not `disabled`, so that focus stays and Esc still closes the dialog) while it
  is written and the share sheet is open: a recording of hundreds of megabytes is a few hundred bridge calls.
- **Clearing the folder waits for every removal**, also when one fails: a removal of an old file of the same name that finished after the
  new file was written would delete it (found while planning the mutation pass, now a test).
- **Found by the audit and fixed:** see *The audit*, the system bars.
- **Not done:** narrowing the file provider's paths; the stale history entry that a sheet closed with its X leaves (E3's follow-up).

### The audit of the Android shell

Read from the sources in `node_modules` (`@capacitor/android`, `@capacitor/app`, `@capacitor/share`, `@capacitor/filesystem`), the
Android project in `android/` and the page; what needs a device is marked **(device)**.

| Area | What is there | Verdict |
|---|---|---|
| **Back** | Without `@capacitor/app` nobody handles the button and the activity finishes (the music ends). With it, and a page listener, the plugin sends `{ canGoBack }` and does nothing else. | **Fixed**: `canGoBack` goes back through the history (every sheet, question and page is an entry there); at the root the app goes to the background. `Bridge.onPause` does not pause the WebView (`KeepRunning` defaults to true), so playback is not stopped from the app's side. **(device)**: whether the system lets a process without a foreground service play for long. |
| **Status and gesture bars** | `SystemBars` (Capacitor 8 core) picks the icon colour from the phone's night mode when `style` is `DEFAULT`; the page is always dark. On a phone in light mode that is dark icons on a dark page, and the theme's window background (light, from `DayNight`) shows behind the bars on a WebView older than 140 and until the first paint. | **Fixed**: `plugins.SystemBars.style = DARK` in `capacitor.config.json` and `android:windowBackground = #0A0A0F` in the activity's theme (`colors.xml`), both pinned by a test, the colour equal to the page's `theme-color`. **(device)**: how it looks. |
| **Insets** | `insetsHandling: css` (the default), `viewport-fit=cover` in `index.html`; a WebView of 140 or newer passes the insets on as `env(safe-area-inset-*)` (what `.pt-safe` and `.pb-safe` read), an older one gets the decor view padded and `env()` is 0. The keyboard's height is padded by the plugin. `targetSdk` 36 makes edge-to-edge compulsory from Android 15. | **Left as it is**, plus `initialViewportFitValueHint: cover` so that nothing shifts when the page appears. **(device)**: a phone with a cut-out and three-button navigation. |
| **Permissions** | `INTERNET` only. The share sheet and the app's own cache folder need none. | **Pinned**, and no plugin we depend on declares a permission, `uses-feature`, `queries`, activity, service, receiver or provider (a unit test reads each plugin's manifest). The Filesystem plugin is Kotlin and brings one library of its own, `io.ionic.libs:ionfilesystem-android` 1.1.1: its AAR (read from Maven Central on 2026-10-19) has a manifest with only `uses-sdk`, and its other dependencies are Kotlin, coroutines, `core-ktx` and `activity-ktx`, which the app already pulls. What a later upgrade of a plugin pulls in is not visible to a unit test, so a step of the APK workflow lists the permissions of the finished APK and fails on anything but `INTERNET` (and AndroidX's signature-level `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`); it was written without an SDK to try it on, so its first run is its check. |
| **Plugin reach** | A script running in the page can call every method the native side lists, not only the calls the app makes: `Filesystem` can read, write and delete in the app's own folders (it has no storage permission, so nothing of other apps), `Share` can hand a file the app can read to another app. | **No change**, recorded because adding the two plugins is what widens it: the Content-Security-Policy (no remote script, no inline script, no `eval`, `connect-src 'self'`, and `allowNavigation` empty, which a test pins) is what keeps such a script from existing. |
| **Files** | The app's `FileProvider` (`${applicationId}.fileprovider`, not exported, grants URI permissions) is the authority the Share plugin builds its addresses with; `file_paths.xml` has the template's `cache-path .` and `external-path .`. A saved file waits in the app's private cache folder (another app reaches it only through the grant to the share target) until the next save removes it, or Android's *Clear cache* does. | **Pinned** (private, the authority, a `cache-path` that covers `wavelocal-share/`). **Left**: `external-path .` is not used and could go, and `cache-path .` could be `wavelocal-share/`; with no storage permission and an unexported provider both are inert, and a wrong path makes every share fail with no way to try it here. |
| **Activity** | `launchMode=singleTask`; `configChanges` lists orientation, size, density, `uiMode`, keyboard and locale, so rotating or changing the phone's theme does not recreate the activity (and stop the music). | **Left as it is.** |
| **Backups, cleartext** | `allowBackup=false`, data-extraction rules, no cleartext, system certificates only. | Pinned since E4. |
| **Message size** | Every call is a JSON message through `androidBridge.postMessage`; a slice is 768 KiB (1 MiB of base64). | **(device)**: nothing here can say whether the bridge copes with a megabyte per call at a few hundred calls. |
| **Share result** | `Share canceled` when the chooser was dismissed (`RESULT_CANCELED` while the app was not stopped); a second call while one is open is `Can't share while sharing is in progress`. | Mapped to *cancelled* and *busy*. **(device)**: how each Android version reports a dismissed chooser. |
| **Background playback** | No foreground service, no media notification (a parking-lot item that needs the SDK and a device). | Unchanged. |

### Numbers

Unit tests: 3,566 (it was 3,396 after F2); e2e: 588 (`savefile` 17, `androidshell` 9; it was 562); the 26 desktop smoke tests. A mutation pass
of 92 deliberate breaks in a scratch copy of the tree (the saver, the names, the dispatcher and its words, the Back rule and its
listener, the after-load starter, `isNativeApp`, the Android project files and the wiring in the app): 88 were caught at once. Of the four
survivors, one was a dead branch of `safeFileName` (deleted), two were tests that did not look hard enough (the longest name that fits,
which differs from the next one only when a space comes before the extension, and a second click on a busy button that the saver's own
guard answered quietly: both now assert more and the breaks are caught), and one removed `'shell'` from the log's kinds, which only the type
checker sees (its e2e twin is caught). Two flaky tests of my own were found by repeating the new specs eight times with four workers:
a release of the held share sheet before it was open, and an axe scan of the whole Sound & tools dialog that met the dimmed Reverb section
(it is now scoped to the backup panel, as `backup.spec.ts` does). Initial JS 124.8 of 125.0 kB; the lazy chunks the Android app adds:
`capacitor` 3.0 kB, `plugins` 1.3 kB, `androidshell` 0.3 kB (gzip), plus `afterload` 0.4 kB and `platform` 0.1 kB that the web fetches too.
