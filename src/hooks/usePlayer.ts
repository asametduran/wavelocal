import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AudioEngine, EQ_PRESETS } from '../lib/engine'
import { getAllTracks, getMeta, toRecord } from '../lib/db'
import type { LibraryReader } from '../lib/persist/load'
import { normalizeMeta } from '../lib/trackmeta'
import { claimWindow, writeGate } from '../lib/persist/gate'
import { clearTracks, patchTracks, removeTrack, saveMeta, saveTracks } from '../lib/persist/write'
import { countLabel } from '../lib/format'
import { estimateGainDb } from '../lib/loudness'
import { buildTrack, isAudioFile, lrcFromFile, norm, revokeTrack } from '../lib/metadata'
import { importFiles } from '../lib/importer'
import { analyzeOnDemand } from '../lib/analyzeOnDemand'
import { needsUpgrade, upgradeLibrary, upgradePatch } from '../lib/upgrade'
import type { UpgradePatch } from '../lib/upgrade'
import { announce } from '../lib/a11y'
import { PlaybackFaults, mediaFault } from '../lib/faults'
import { note } from '../lib/diagnostics/capture'
import { safeStart } from '../lib/safestart'
import { contextQueue, mergeTrackIds, moveItem, nextAfterRemoval, nextRepeat, pickTrack } from '../lib/queue'
import { parseSortSpec } from '../lib/sort'
import type { SortSpec } from '../lib/sort'
import { viewTracks } from '../lib/view'
import { confirmDialog, toast } from '../lib/overlays'
import { cleanName, copyName, restorePlaylist } from '../lib/playlists'
import { continueAfter, dequeueAt, keepKnown, moveQueued, queueLast, queueNext, requeueAt, resumeAfterQueued, takeQueued, unqueue } from '../lib/upnext'
import { mediaSkip } from '../lib/mediaskip'
import type { Resume, Taken } from '../lib/upnext'
import type { Backup, PendingRestore, ResolveResult, RestoreSummary } from '../lib/backup'
import { PlayTally } from '../lib/plays'
import { asLoop, loopStep } from '../lib/loop'
import type { LoopRange } from '../lib/loop'
import type { BookmarksByKey } from '../lib/listening/types'
import { isSmartId, smartList, smartTracks } from '../lib/smart'
import { applyTagEdit } from '../lib/tags'
import type { TagEdit } from '../lib/tags'
import { PlayableResolver, createWorkerConvert } from '../lib/audio/playable'
import { AudioDecodeError } from '../lib/audio/errors'
import { mergeSpatial, normalizeSpatial } from '../lib/spatial'
import { addBand, bandsFromSettings, deletePreset, findPreset, graphicBands, normalizePresets, removeBand, savePreset, updateBand } from '../lib/eq'
import { mergeReverb, normalizeReverb } from '../lib/reverb'
import { mergeDynamics, mergeStereo, mergeTone, normalizeDynamics, normalizeStereo, normalizeTone } from '../lib/dynamics'
import type { DynamicsPatch, DynamicsSettings, EqBand, EqPreset, ImportProgress, Lyrics, MetaValues, PlayFromOptions, PlayerApi, Playlist, RepeatMode, ReverbSettings, Settings, SpatialSettings, StereoSettings, TagEditOutcome, ToneSettings, Track, TransitionMode, UpgradeProgress } from '../types'

/** The saved library as the loader reads it: the tracks, and the values of `meta`. */
const savedLibrary: LibraryReader = { rows: getAllTracks, meta: (key) => getMeta(key as keyof MetaValues) }

// Backups are rare: the code that makes, reads and restores them is only fetched when one is needed.
const loadBackup = () => import('../lib/backup')

// The storage checks only matter when an import runs or a save fails, so they are not part of the start-up code either.
const loadStorage = () => import('../lib/storage')

/** What to tell the listener when a save failed: out of space gets its own advice, anything else the `fallback`. */
async function saveFailureText(error: unknown, fallback: string): Promise<string> {
  try {
    return (await loadStorage()).describeSaveFailure(error, fallback)
  } catch {
    return fallback
  }
}

/** With no room left on the device, reading the rest of an import would only fail the same way. */
async function stopWhenFull(error: unknown, stop: () => void): Promise<void> {
  try {
    if ((await loadStorage()).isQuotaError(error)) stop()
  } catch {
    // keep importing
  }
}

/** Ask before an import that will not fit in the room the device has left. Resolves false if the listener says no. */
async function hasRoomFor(files: readonly File[]): Promise<boolean> {
  try {
    const { readEstimate, importFit, formatBytes } = await loadStorage()
    const fit = importFit(files.filter(isAudioFile).map((file) => file.size), await readEstimate())
    if (fit.fits) return true
    return await confirmDialog({
      title: 'Not enough room?',
      message: `These files are about ${formatBytes(fit.needed)}, and this device has about ${formatBytes(fit.free)} left for Wavelocal. Wavelocal keeps its own copy of every track you add. Add them anyway?`,
      confirmLabel: 'Add anyway',
    })
  } catch {
    return true // never block an import because the check itself failed
  }
}

/** After an import: say so, once per level, when storage is getting full. */
async function warnIfLow(notify: (text: string) => void): Promise<void> {
  try {
    const { assessStorage, readEstimate, readPersisted, shouldWarn, warningFor } = await loadStorage()
    const assessment = assessStorage(await readEstimate())
    if (!shouldWarn(assessment.level)) return
    const warning = warningFor(assessment, await readPersisted())
    if (warning) notify(warning.text)
  } catch {
    // the warning is a courtesy
  }
}

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))
const NO_TRACKS: readonly Track[] = []
const newPlaylistId = (): string => `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const XFADE_SECS = 5
const SLEEP_FADE_SECS = 12
const SETTINGS_KEY = 'wl-settings'

type DeckIndex = 0 | 1
const otherDeck = (i: DeckIndex): DeckIndex => (i === 0 ? 1 : 0)
type Timer = ReturnType<typeof setTimeout>

/** `preservesPitch` has vendor-prefixed spellings on older engines. */
type PitchAudio = HTMLAudioElement & { mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean }

/** Latest render's state, readable from stable callbacks and media-element listeners without stale closures. */
interface Snapshot {
  tracks: Track[]
  /** The list on screen, in the order it is shown. */
  queue: readonly Track[]
  /** What next/previous/shuffle move through (see `playFrom`). */
  playQueue: readonly Track[]
  playlists: Playlist[]
  viewId: string
  sort: SortSpec
  /** The tracks queued by hand (Up Next), by id, in play order. */
  upNext: readonly string[]
  currentId: string | null
  repeat: RepeatMode
  shuffle: boolean
  transition: TransitionMode
  normalize: boolean
  hydrated: boolean
  /** The part of the track that repeats, or null. Set only through `setLoop`, which keeps this and the state of the hook the same. */
  loop: LoopRange | null
}

interface CrossfadeState {
  timer: Timer | null
  active: boolean
  /** The track already chosen (and preloaded) to play next. */
  pending: Track | null
}

function loadSettings(): Partial<Settings> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return (raw ? (JSON.parse(raw) as Partial<Settings> | null) : null) || {}
  } catch {
    return {}
  }
}

/** What is said when a track could not be played and playback went on without it. */
const skippedText = (track: Track): string => `Skipped "${track.title}": it could not be played.`

/** Owns the audio engine (two decks, EQ, analyser) plus queue, playlists, persistence and playback state. */
export function usePlayer(): PlayerApi {
  const [engine] = useState(() => new AudioEngine())
  // decides what each <audio> element is given: the original file, or (for WAV/FLAC the browser cannot play) a decoded copy
  const [resolver] = useState(() => new PlayableResolver({ convert: createWorkerConvert(), element: engine.decks[0].el }))
  // which sources failed, which tracks cannot be played, and how long the run of failures is (the rules are in `lib/faults.ts`)
  const [faults] = useState(() => new PlaybackFaults())
  const [saved] = useState(loadSettings)

  const [tracks, setTracks] = useState<Track[]>([]) // the whole library
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [viewId, setViewId] = useState('all')
  const [sort, setSortState] = useState<SortSpec>(() => parseSortSpec(saved.sort))
  /** Ids of the album or artist page a track was last started from; null while playback follows the list on screen. */
  const [context, setContext] = useState<readonly string[] | null>(null)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [loop, setLoopState] = useState<LoopRange | null>(null)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState(saved.volume ?? 0.8)
  const [muted, setMuted] = useState(saved.muted ?? false)
  const [repeat, setRepeat] = useState<RepeatMode>(saved.repeat ?? 'off')
  const [shuffle, setShuffle] = useState(saved.shuffle ?? false)
  const [transition, setTransition] = useState<TransitionMode>(saved.transition ?? 'off')
  // the shared equalizer, plus optional per-track overrides; the curve in effect is derived from the two (see below)
  const [globalBands, setGlobalBands] = useState<EqBand[]>(() => bandsFromSettings(saved))
  const [trackEq, setTrackEq] = useState<Record<string, EqBand[]>>({})
  /** Parts of a restored backup whose files are not in the library yet; they complete as the files are added. */
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null)
  const pendingRef = useRef<PendingRestore | null>(null)
  const [eqPresets, setEqPresets] = useState<EqPreset[]>(() => normalizePresets(saved.eqPresets))
  const [eqOn, setEqOn] = useState(saved.eqOn ?? true)
  const [speed, setSpeedState] = useState(clamp(saved.speed ?? 1, 0.5, 2))
  const [preservePitch, setPreservePitch] = useState(saved.preservePitch ?? true)
  const [normalize, setNormalize] = useState(saved.normalize ?? false)
  const [spatial, setSpatialState] = useState<SpatialSettings>(() => normalizeSpatial(saved.spatial))
  const [reverb, setReverbState] = useState<ReverbSettings>(() => normalizeReverb(saved.reverb))
  const [dynamics, setDynamicsState] = useState<DynamicsSettings>(() => normalizeDynamics(saved.dynamics))
  const [stereo, setStereoState] = useState<StereoSettings>(() => normalizeStereo(saved.stereo))
  const [tone, setToneState] = useState<ToneSettings>(() => normalizeTone(saved.tone))
  const [sleepLeft, setSleepLeft] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  /** Ids of the tracks queued by hand (Up Next), in play order: they play before the list on screen carries on. */
  const [upNext, setUpNextState] = useState<readonly string[]>([])
  const [hydrated, setHydrated] = useState(false)
  /** Progress (0..1) of decoding the current track in JavaScript, or null when it is not being decoded. */
  const [decoding, setDecoding] = useState<number | null>(null)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [upgradeProgress, setUpgradeProgress] = useState<UpgradeProgress | null>(null)

  const active = useRef<DeckIndex>(0) // index of the deck the user is hearing
  const history = useRef<string[]>([])
  /** Where the list carries on while a track from Up Next plays: after the one it interrupted, not after itself. */
  const resume = useRef<Resume | null>(null)
  const xfade = useRef<CrossfadeState>({ timer: null, active: false, pending: null })
  const sleep = useRef({ end: 0, fading: false })
  const pendingSeek = useRef<number | null>(null)
  /** Bumped on every load so a slow decode of an earlier track can tell that it has been superseded. */
  const loadToken = useRef(0)
  /** True while the current track has been chosen but its audio source is not ready yet (WAV/FLAC being checked or decoded). */
  const awaitingSrc = useRef(false)
  /** Whether the current load should start playing once its source is ready. */
  const playIntent = useRef(false)
  /** Decides when listening counts as a play (half the track or 30 s of real listening). */
  const tally = useRef(new PlayTally())
  /** The jump of an A-B loop, scheduled for the moment the playhead reaches its end. */
  const loopTimer = useRef<Timer | null>(null)
  /** Set after `next` exists; used where a track turned out to be unplayable (`announced`: the caller has already said why). */
  const skipUnplayable = useRef<(track: Track, announced?: boolean) => void>(() => {})
  /** Imports run one after another (so none misses what the one before added); each has its own abort controller. */
  const importChain = useRef<Promise<unknown>>(Promise.resolve())
  const importAborts = useRef(new Set<AbortController>())
  const importsPending = useRef(0)
  /** Bumped when the library is cleared, so work still in flight for the old library is thrown away. */
  const libraryEpoch = useRef(0)
  const upgradeAbort = useRef<AbortController | null>(null)
  const state = useRef<Snapshot>({
    tracks: [],
    queue: [],
    playQueue: [],
    playlists: [],
    viewId: 'all',
    sort,
    upNext: [],
    currentId: null,
    repeat,
    shuffle,
    transition,
    normalize,
    hydrated: false,
    loop: null,
  })

  // A smart list is ordered once, when it is opened (or when tracks are added/removed), and not on every play count:
  // otherwise the row you are listening to would jump around under you each time a play is recorded.
  const smartIds = useMemo(() => {
    const list = smartList(viewId)
    return list ? smartTracks(list.kind, tracks).map((t) => t.id) : null
  }, [viewId, tracks.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const queue = useMemo<readonly Track[]>(() => {
    if (!smartIds) return viewTracks(tracks, playlists, viewId, sort)
    return contextQueue(tracks, smartIds)
  }, [tracks, playlists, viewId, smartIds, sort])
  // Browsing does not change what plays next: a track started from an album or artist page keeps playing from that page,
  // and the list on screen can change meanwhile. A page with no tracks left in the library falls back to the list.
  const playQueue = useMemo<readonly Track[]>(() => {
    if (!context) return queue
    const list = contextQueue(tracks, context)
    return list.length ? list : queue
  }, [context, tracks, queue])

  state.current = { ...state.current, tracks, queue, playQueue, playlists, viewId, sort, upNext, currentId: state.current.currentId ?? currentId, repeat, shuffle, transition, normalize, hydrated }
  const current = useMemo(() => tracks.find((t) => t.id === currentId) || null, [tracks, currentId])
  const upNextTracks = useMemo<readonly Track[]>(() => {
    if (!upNext.length) return NO_TRACKS
    const byId = new Map(tracks.map((t) => [t.id, t]))
    return upNext.flatMap((id) => {
      const t = byId.get(id)
      return t ? [t] : []
    })
  }, [upNext, tracks])

  const getEl = useCallback(() => engine.decks[active.current].el, [engine])

  const notify = useCallback((msg: string) => {
    toast(msg)
  }, [])

  /** Change the queue at once (the next render would be too late for a track that fails to start) and show it. */
  const commitUpNext = useCallback((next: readonly string[]) => {
    if (next === state.current.upNext) return
    state.current.upNext = next
    setUpNextState(next)
  }, [])

  /** A queued track starts for real: it leaves the queue, and the list will carry on after the track it interrupted. */
  const applyTaken = useCallback(
    (taken: Taken<Track>) => {
      resume.current = taken.resume
      commitUpNext(taken.queue)
    },
    [commitUpNext],
  )

  /**
   * A track that could not be played is not chosen again until it is asked for by hand, and it leaves Up Next: it would be passed over
   * at its turn anyway, and the list would go on showing a track that is never going to play.
   */
  const giveUp = useCallback(
    (id: string) => {
      faults.markBad(id)
      if (state.current.upNext.includes(id)) commitUpNext(state.current.upNext.filter((queued) => queued !== id))
    },
    [commitUpNext, faults],
  )

  const startPlay = useCallback(
    (el: HTMLAudioElement) => {
      // remember that playback is wanted: if the source is still being decoded, or the browser rejects it and we have to
      // retry with a decoded copy, playback then starts by itself
      playIntent.current = true
      if (awaitingSrc.current) return Promise.resolve()
      engine.init()
      return el.play().catch(() => setPlaying(false))
    },
    [engine],
  )

  /**
   * The A-B loop: the part of the track that repeats, or null. It belongs to the track that is playing and goes when another one
   * starts. While it is set the track is held (nothing is preloaded, no transition starts) and its end jumps back to its start.
   */
  const setLoop = useCallback((range: LoopRange | null) => {
    if (loopTimer.current) clearTimeout(loopTimer.current)
    loopTimer.current = null
    const next = asLoop(range) // anything but two ordered times is no loop
    state.current.loop = next
    setLoopState(next)
  }, [])

  /** Look at the loop from where the playhead is: jump back now, or schedule the jump for its end. True while a loop holds the track. */
  const stepLoop = useCallback((): boolean => {
    if (loopTimer.current) clearTimeout(loopTimer.current)
    loopTimer.current = null
    const held = state.current.loop
    if (!held) return false
    const el = getEl()
    if (el.paused) return true
    const step = loopStep(held, el.currentTime, el.playbackRate)
    if (step.kind === 'jump') {
      el.currentTime = held.a
      tally.current.jumped() // going round again is not listening to more of the track
      setTime(held.a)
    } else if (step.kind === 'wait') loopTimer.current = setTimeout(stepLoop, step.seconds * 1000)
    return true
  }, [getEl])

  const cancelTransition = useCallback(() => {
    const x = xfade.current
    if (x.timer) clearTimeout(x.timer)
    x.timer = null
    x.pending = null
    const other = otherDeck(active.current)
    if (x.active || !engine.decks[other].el.paused) engine.decks[other].el.pause()
    x.active = false
    if (engine.ctx) {
      engine.setGain(active.current, 1)
      engine.setGain(other, 1)
    }
  }, [engine])

  /** Set the loudness-normalization gain for the track sitting on a deck (estimating it once if unknown). */
  const applyNorm = useCallback(
    (deckIdx: DeckIndex, track: Track | null | undefined) => {
      if (!track) return
      if (!state.current.normalize) {
        engine.setNorm(deckIdx, 1)
        return
      }
      if (track.gainDb != null) {
        engine.setNorm(deckIdx, 10 ** (track.gainDb / 20))
        return
      }
      estimateGainDb(track.file).then((g) => {
        setTracks((l) => l.map((t) => (t.id === track.id ? { ...t, gainDb: g } : t)))
        const latest = state.current.tracks.find((t) => t.id === track.id) || track
        saveTracks([{ ...latest, gainDb: g }], { quiet: true }).catch(() => {})
        if (state.current.normalize && engine.decks[deckIdx].el.getAttribute('src') === track.url) engine.setNorm(deckIdx, 10 ** (g / 20))
      })
    },
    [engine],
  )

  const load = useCallback(
    (track: Track | null | undefined, autoplay = true, at: number | null = null) => {
      if (!track) return
      faults.forget(track.id) // trying a track is a fresh start for it: a failure may have passed, and if not, it is found out again
      cancelTransition()
      const el = getEl()
      const token = ++loadToken.current
      awaitingSrc.current = false
      playIntent.current = autoplay
      pendingSeek.current = at // a position that was waiting for another track is not this one's
      setLoop(null)
      state.current.currentId = track.id
      setCurrentId(track.id)
      setTime(0)
      setDuration(track.duration || 0)
      setDecoding(null)
      resolver.retain([track.id])

      const src = resolver.urlFor(track)
      if (src) {
        el.src = src
        faults.attach(active.current, track.id, src)
        applyNorm(active.current, track)
        if (autoplay) startPlay(el)
        return
      }

      // WAV/FLAC: look inside the file first, and decode it ourselves if the browser cannot play it
      awaitingSrc.current = true
      el.removeAttribute('src')
      el.load()
      const deck = active.current
      resolver
        .resolve(track)
        .then((url) => {
          if (token !== loadToken.current) return
          awaitingSrc.current = false
          el.src = url
          faults.attach(deck, track.id, url)
          applyNorm(deck, track)
          if (playIntent.current) startPlay(el) // true if this load autoplays, or the user pressed play while it was pending
        })
        .catch((error: unknown) => {
          if (token !== loadToken.current) return
          awaitingSrc.current = false
          setDecoding(null)
          note('decode')(error) // the app's own decoder could not read it either
          giveUp(track.id)
          notify(`Could not play "${track.title}": ${error instanceof Error ? error.message : 'unsupported audio'}`)
          if (playIntent.current) skipUnplayable.current(track, true)
        })
    },
    [applyNorm, cancelTransition, faults, getEl, giveUp, notify, resolver, setLoop, startPlay],
  )

  /**
   * The track to move to. What was queued by hand (Up Next) plays before the list carries on; `commit` false is looking
   * ahead (preloading the next track), which must not use the queue up.
   */
  const pickNext = useCallback(
    (dir: 1 | -1, auto: boolean, commit = true): Track | null => {
      const s = state.current
      if (dir > 0 && s.upNext.length) {
        const taken = takeQueued(s.upNext, resume.current, s.currentId, (id) => s.tracks.find((t) => t.id === id))
        if (taken) {
          if (commit) applyTaken(taken)
          return taken.track
        }
      }
      // forward, the list carries on after the track a queued one interrupted; back, a queued track steps back through what was played
      const queuedPlaying = resume.current !== null && resume.current.forId === s.currentId
      const picked = pickTrack({
        queue: s.playQueue,
        currentId: dir > 0 ? continueAfter(resume.current, s.currentId) : s.currentId,
        repeat: s.repeat,
        shuffle: s.shuffle,
        history: history.current,
        dir,
        auto,
        useHistory: dir < 0 && queuedPlaying,
        find: (id) => s.tracks.find((t) => t.id === id),
        skip: faults.unplayable, // a track that could not be played is not chosen again, so a queue of them ends the chain by itself
      })
      history.current = [...picked.history]
      if (commit) resume.current = null // the track picked is a list track again
      return picked.track
    },
    [applyTaken, faults],
  )

  /**
   * `t`, picked earlier by looking ahead, really starts now. A queued track leaves the queue only here, once it has a source
   * to play: one that was used up and then could not start yet (a big FLAC still being decoded) would be lost. A track from
   * the list puts the list back in charge.
   */
  const takePick = useCallback(
    (t: Track) => {
      const s = state.current
      const taken = s.upNext.length ? takeQueued(s.upNext, resume.current, s.currentId, (id) => s.tracks.find((x) => x.id === id)) : null
      if (taken && taken.track.id === t.id) applyTaken(taken)
      else resume.current = null
    },
    [applyTaken],
  )

  /**
   * A deck reported that the source it was given cannot be played: an `error` event, or a `play()` the browser refused for the
   * file's sake. It counts once per source (`lib/faults.ts`), whichever deck it is and however late the report comes.
   */
  const failedSource = useCallback(
    (deck: DeckIndex) => {
      const el = engine.decks[deck].el
      const failure = faults.fail(deck, el.getAttribute('src'))
      if (failure.kind === 'ignore') return
      const track = state.current.tracks.find((t) => t.id === failure.trackId)
      if (!track) return // it was removed meanwhile
      // Read now, for emptying the deck below clears it. It goes in the error log only when the track is given up on: a lossless file
      // that the browser cannot play and the app decodes is no failure.
      const fault = mediaFault(el.error)

      if (deck !== active.current) {
        // The deck lined up for the next track. That track is not handed over to. A lossless file the browser could not preload may
        // still be decoded when its turn comes, so it is only left out of the lining up; anything else is skipped for good.
        faults.markNoPreload(track.id)
        if (xfade.current.pending?.id === track.id) xfade.current.pending = null
        faults.detach(deck)
        el.removeAttribute('src')
        el.load()
        const skip = () => {
          note('play')(fault)
          giveUp(track.id)
          notify(skippedText(track))
        }
        resolver.isDecodable(track).then((decodable) => {
          if (!decodable) skip()
        }, skip)
        return
      }

      if (failure.src === track.url) {
        // the browser rejected the original file; if it is WAV or FLAC, decode it ourselves and try again
        const token = ++loadToken.current
        awaitingSrc.current = true
        resolver
          .isDecodable(track)
          .then((ok) => {
            if (!ok) throw new AudioDecodeError('not a WAV or FLAC file', 'unsupported')
            return resolver.forceDecode(track)
          })
          .then((url) => {
            if (token !== loadToken.current) return
            awaitingSrc.current = false
            el.src = url
            faults.attach(deck, track.id, url)
            if (playIntent.current) startPlay(el)
          })
          .catch((error: unknown) => {
            if (token !== loadToken.current) return
            awaitingSrc.current = false
            note('play')(fault)
            // a file that is neither WAV nor FLAC has only the browser's verdict, which is logged above
            if (!(error instanceof AudioDecodeError && error.code === 'unsupported')) note('decode')(error)
            skipUnplayable.current(track)
          })
        return
      }
      note('play')(fault)
      skipUnplayable.current(track)
    },
    [engine, faults, giveUp, notify, resolver, startPlay],
  )

  /** Start the next track on the idle deck (overlapping for crossfade, immediate for gapless). */
  const beginTransition = useCallback(
    (mode: 'crossfade' | 'gapless') => {
      const x = xfade.current
      if (x.active || state.current.loop) return // a loop set after the handover was already timed still holds the track
      const s = state.current
      const pend = x.pending
      // the pick made while looking ahead still stands when it is the head of Up Next, or (with nothing queued) in the list
      const stands = !!pend && (s.upNext[0] === pend.id || (s.upNext.length === 0 && s.playQueue.some((t) => t.id === pend.id)))
      const nextT = stands && pend ? pend : pickNext(1, true, false) // only looking: nothing is used up until the track starts
      if (!nextT) return
      const cur = active.current
      const nxt = otherDeck(cur)
      const outEl = engine.decks[cur].el
      const inEl = engine.decks[nxt].el
      const hasCtx = engine.init()
      const secs = mode === 'crossfade' && hasCtx ? clamp((outEl.duration || 0) / 2, 1, XFADE_SECS) : 0
      const nextSrc = resolver.urlFor(nextT)
      if (!nextSrc) {
        // still being checked or decoded: warm it up, and let the normal "track ended" path pick it up if it is late
        // (it is still queued, if it came from Up Next: only a track that really starts is taken from the queue)
        resolver.resolve(nextT).catch(() => {})
        return
      }
      takePick(nextT)
      if (inEl.getAttribute('src') !== nextSrc) {
        inEl.src = nextSrc
        faults.attach(nxt, nextT.id, nextSrc)
      }
      applyNorm(nxt, nextT)
      inEl.currentTime = 0
      if (hasCtx) engine.setGain(nxt, secs ? 0 : 1)
      inEl.play().catch(() => {}) // a file that cannot be played is reported by the deck's `error` event (see `failedSource`)
      if (secs) {
        engine.ramp(nxt, 1, secs)
        engine.ramp(cur, 0, secs)
      }
      if (s.currentId) history.current.push(s.currentId)
      active.current = nxt
      state.current.currentId = nextT.id
      x.active = true
      x.pending = null
      setCurrentId(nextT.id)
      setTime(0)
      setDuration(nextT.duration || 0)
      x.timer = setTimeout(
        () => {
          outEl.pause()
          if (engine.ctx) engine.setGain(cur, 1)
          x.active = false
          x.timer = null
        },
        (secs || 0.05) * 1000 + 150,
      )
    },
    [engine, pickNext, takePick, applyNorm, resolver, faults],
  )

  const next = useCallback(
    (auto = false) => {
      const t = pickNext(1, auto)
      if (!t) {
        cancelTransition()
        const el = getEl()
        el.pause()
        el.currentTime = 0
        return
      }
      if (state.current.currentId) history.current.push(state.current.currentId)
      load(t)
    },
    [cancelTransition, getEl, load, pickNext],
  )

  skipUnplayable.current = (track, announced = false) => {
    giveUp(track.id)
    const streak = faults.noteFailure()
    // the first track of a run is named; the run is counted when a track can be read again (see `onMeta`)
    if (streak === 1 && !announced) notify(skippedText(track))
    // every track that fails is given up on, so each failure leaves fewer to go on with: the chain of failures ends by itself
    const following = pickNext(1, true)
    if (!following) {
      // nothing is left to go on with: stop, whatever repeat and shuffle say, and say so once when it is because nothing can be played
      faults.progress()
      if (!state.current.playQueue.some((t) => !faults.isUnplayable(t.id))) notify('None of the next tracks could be played')
      cancelTransition()
      playIntent.current = false
      setPlaying(false)
      getEl().pause()
      return
    }
    if (state.current.currentId) history.current.push(state.current.currentId)
    load(following, playIntent.current)
  }

  const prev = useCallback(() => {
    const el = getEl()
    if (el.currentTime > 3) {
      el.currentTime = 0
      return
    }
    const t = pickNext(-1, false)
    if (t) load(t)
  }, [getEl, load, pickNext])

  const play = useCallback(
    (id: string) => {
      const t = state.current.tracks.find((x) => x.id === id)
      if (!t) return
      // started from the list on screen: playback follows that list again, not an album page it was last started from
      setContext(null)
      resume.current = null
      state.current.playQueue = state.current.queue
      // asked for by hand: a track that could not be played is loaded again, not just started
      const again = faults.isUnplayable(id)
      if (id === state.current.currentId && !again) {
        startPlay(getEl())
        return
      }
      if (state.current.currentId && id !== state.current.currentId) history.current.push(state.current.currentId)
      load(t)
    },
    [faults, getEl, load, startPlay],
  )

  const playFrom = useCallback(
    (ids: readonly string[], { startId, shuffle: shuffled = false }: PlayFromOptions = {}) => {
      const list = contextQueue(state.current.tracks, ids)
      // a start that is not on the page is ignored; with none given, a shuffle starts anywhere and a plain play at the top
      const start = (startId ? list.find((t) => t.id === startId) : undefined) ?? (shuffled ? list[Math.floor(Math.random() * list.length)] : list[0])
      if (!start) return
      if (shuffled) setShuffle(true)
      resume.current = null
      setContext(list.map((t) => t.id))
      state.current.playQueue = list // usable at once: the next render would be too late for a track that fails to start
      const again = faults.isUnplayable(start.id) // asked for by hand: loaded again, as `play` does
      if (start.id === state.current.currentId && !again) {
        const el = getEl()
        if (!startId) el.currentTime = 0 // "Play" on a page whose first track is already playing starts it over
        startPlay(el)
        return
      }
      if (state.current.currentId && start.id !== state.current.currentId) history.current.push(state.current.currentId)
      load(start)
    },
    [faults, getEl, load, startPlay],
  )

  const toggle = useCallback(() => {
    if (!state.current.currentId) {
      // with nothing playing, what was queued by hand goes first, as it would after a track
      const first = (state.current.upNext.length ? pickNext(1, false) : null) ?? state.current.playQueue[0]
      resume.current = null // nothing was playing, so there is nothing to carry on after
      if (first) load(first)
      return
    }
    const el = getEl()
    if (!el.paused) {
      el.pause()
      return
    }
    const current = state.current.tracks.find((t) => t.id === state.current.currentId)
    if (current && faults.isUnplayable(current.id)) {
      // it could not be played before: asked for again, it is loaded again (a new source for the deck)
      load(current)
      return
    }
    startPlay(el)
  }, [faults, getEl, load, pickNext, startPlay])

  const seek = useCallback(
    (t: number) => {
      const el = getEl()
      if (!Number.isFinite(t)) return
      if (!Number.isFinite(el.duration)) {
        // the browser has not read the file yet (a slow disk, a page just restored), but the library knows how long it is,
        // so the bar can be used: the position is made as soon as the file can take it, the way a restored one is
        pendingSeek.current = Math.max(0, t)
        setTime(pendingSeek.current)
        return
      }
      el.currentTime = clamp(t, 0, el.duration)
      tally.current.jumped() // a seek is not listening
      setTime(el.currentTime)
    },
    [getEl],
  )
  const seekBy = useCallback((d: number) => seek((pendingSeek.current ?? getEl().currentTime) + d), [getEl, seek])

  /** A play has been earned: bump the counter in memory and in the offline library. */
  const recordPlay = useCallback((id: string) => {
    const latest = state.current.tracks.find((t) => t.id === id)
    if (!latest) return
    const stamp = { plays: (latest.plays || 0) + 1, lastPlayedAt: Date.now() }
    setTracks((l) => l.map((t) => (t.id === id ? { ...t, ...stamp } : t)))
    saveTracks([{ ...latest, ...stamp }], { quiet: true }).catch(() => {})
  }, [])

  // ---- backup and restore ----
  /** Make a merge result real: patch tracks, playlists and curves, remember what is still waiting, and save it all. */
  const commitRestore = useCallback((r: Pick<ResolveResult, 'patches' | 'trackEq' | 'playlists' | 'pending'>) => {
    const s = state.current
    if (r.patches.size) {
      const changed: Track[] = []
      const next = s.tracks.map((t) => {
        const patch = r.patches.get(t.id)
        if (!patch) return t
        // the track being played keeps its object (and the URLs its audio element is using); the others are rebuilt
        // from their plain record so a restore of thousands of tracks does not mint thousands of object URLs
        const updated = t.id === s.currentId ? { ...t, ...patch } : buildTrack({ ...toRecord(t), ...patch })
        if (t.id !== s.currentId) revokeTrack(t)
        changed.push(updated)
        return updated
      })
      s.tracks = next
      setTracks(next)
      saveTracks(changed).catch((error: unknown) => void saveFailureText(error, 'Could not save the restored data (storage blocked or full)').then(notify))
    }
    setPlaylists(r.playlists)
    setTrackEq(r.trackEq)
    pendingRef.current = r.pending
    setPendingRestore(r.pending)
  }, [notify])

  /** Complete whatever part of a restored backup the library can satisfy now. Free when nothing is pending: the backup code is not even fetched. */
  const resolveNow = useCallback(async (): Promise<void> => {
    if (!pendingRef.current) return
    const { resolvePending } = await loadBackup()
    const pending = pendingRef.current // read again: it may have been resolved, or given up on, while the code was loading
    if (!pending) return
    const r = resolvePending(pending, state.current.tracks, state.current.playlists, trackEqRef.current)
    const progressed = r.patches.size > 0 || r.membersAdded > 0 || r.pending?.tracks.length !== pending.tracks.length || r.pending?.links.length !== pending.links.length
    if (progressed) commitRestore(r)
  }, [commitRestore])

  const exportBackup = useCallback(async (bookmarks?: BookmarksByKey): Promise<string> => {
    const { buildBackup, serializeBackup } = await loadBackup()
    return serializeBackup(buildBackup(state.current.tracks, state.current.playlists, trackEqRef.current, new Date(), bookmarks))
  }, [])

  const planBackup = useCallback(async (backup: Backup) => {
    const { planRestore } = await loadBackup()
    return planRestore(backup, state.current.tracks, state.current.playlists, trackEqRef.current, pendingRef.current, () => `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`)
  }, [])
  const previewBackup = useCallback(async (backup: Backup): Promise<RestoreSummary> => (await planBackup(backup)).summary, [planBackup])
  const applyBackup = useCallback(
    async (backup: Backup): Promise<RestoreSummary> => {
      const plan = await planBackup(backup)
      commitRestore(plan)
      return plan.summary
    },
    [planBackup, commitRestore],
  )
  const discardPendingRestore = useCallback(() => {
    pendingRef.current = null
    setPendingRestore(null)
  }, [])

  const resetPlays = useCallback(() => {
    const cleared = state.current.tracks.filter((t) => t.plays || t.lastPlayedAt)
    if (!cleared.length) return
    setTracks((l) => l.map((t) => (t.plays || t.lastPlayedAt ? { ...t, plays: 0, lastPlayedAt: null } : t)))
    saveTracks(cleared.map((t) => ({ ...t, plays: 0, lastPlayedAt: null }))).catch((error: unknown) => void saveFailureText(error, 'Could not save the reset (storage blocked or full)').then(notify))
  }, [notify])

  const setVolume = useCallback((v: number) => {
    const nv = clamp(v, 0, 1)
    setVolumeState(nv)
    setMuted(nv === 0)
  }, [])
  const volumeBy = useCallback((d: number) => {
    setVolumeState((v) => clamp(Math.round((v + d) * 100) / 100, 0, 1))
    setMuted(false)
  }, [])
  const toggleMute = useCallback(() => {
    if (muted && volume === 0) setVolumeState(0.5)
    setMuted(!muted)
  }, [muted, volume])

  const cycleRepeat = useCallback(() => setRepeat(nextRepeat), [])
  const toggleShuffle = useCallback(() => setShuffle((s) => !s), [])

  // ---- lyrics ----
  const updateLyrics = useCallback((id: string, lyrics: Lyrics | null) => {
    setTracks((l) => l.map((t) => (t.id === id ? { ...t, lyrics } : t)))
    const t = state.current.tracks.find((x) => x.id === id)
    if (t) saveTracks([{ ...t, lyrics }]).catch(() => {})
  }, [])

  const attachLrc = useCallback(
    async (file: Blob) => {
      const id = state.current.currentId
      const lyr = await lrcFromFile(file)
      if (!lyr) return notify('Could not read lyrics from that file')
      if (!id) return notify('Select a track first')
      updateLyrics(id, lyr)
      notify('Lyrics loaded')
    },
    [notify, updateLyrics],
  )

  // ---- tag editing ----
  const editTags = useCallback(async (id: string, edit: TagEdit): Promise<TagEditOutcome> => {
    const before = state.current.tracks.find((x) => x.id === id)
    if (!before) return { ok: false, error: 'That track is no longer in the library' }
    let res
    try {
      res = await applyTagEdit(before, edit)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Could not edit the tags' }
    }
    // the track may have changed (loudness, lyrics) or been removed while the file was rewritten
    const latest = state.current.tracks.find((x) => x.id === id)
    if (!latest) return { ok: false, error: 'That track was removed' }
    const cover = res.coverChanged ? (res.record.coverBlob ? URL.createObjectURL(res.record.coverBlob) : null) : latest.cover
    const updated: Track = {
      ...latest,
      title: res.record.title,
      artist: res.record.artist,
      album: res.record.album,
      file: res.record.file,
      coverBlob: res.record.coverBlob,
      cover,
    }
    try {
      await saveTracks([updated])
    } catch (error) {
      if (res.coverChanged && cover) URL.revokeObjectURL(cover)
      return { ok: false, error: await saveFailureText(error, 'Could not save to the offline library (storage blocked or full)') }
    }
    // `url` stays: the audio is identical, so playback is not interrupted
    state.current.tracks = state.current.tracks.map((x) => (x.id === id ? updated : x))
    setTracks((l) => l.map((x) => (x.id === id ? updated : x)))
    if (res.coverChanged && latest.cover) URL.revokeObjectURL(latest.cover)
    return { ok: true, embedded: res.embedded }
  }, [])

  // ---- library ----
  /**
   * One import: files are read a few at a time and the tracks appear (and are saved) in batches while the rest is still
   * being read, so a big folder shows up at once and survives being cancelled or closed halfway.
   */
  const importOne = useCallback(
    async (files: File[], signal: AbortSignal, stop: () => void): Promise<number> => {
      const epoch = libraryEpoch.current
      const existing = new Set(state.current.tracks.map((t) => t.key))
      let firstBatch = true
      let saveFailed = false
      let shownAt = 0
      const result = await importFiles(files, {
        existingKeys: existing,
        signal,
        // the media element is only asked for the length of files whose headers no probe could read
        analyze: (file) => analyzeOnDemand(file),
        onProgress: (p) => {
          const now = performance.now()
          if (p.done >= p.total || now - shownAt > 120) {
            shownAt = now
            setImportProgress({ ...p })
          }
        },
        onBatch: (added) => {
          if (epoch !== libraryEpoch.current) return // the library was cleared while these were being read
          const wasEmpty = state.current.tracks.length === 0
          state.current.tracks = [...state.current.tracks, ...added]
          setTracks((l) => [...l, ...added])
          if (firstBatch) {
            firstBatch = false
            setViewId('all')
            navigator.storage?.persist?.().catch?.(() => {})
          }
          saveTracks(added).catch((error: unknown) => {
            if (saveFailed) return
            saveFailed = true
            void saveFailureText(error, 'Could not save to the offline library (storage blocked or full)').then(notify)
            void stopWhenFull(error, stop)
          })
          const head = added[0]
          if (wasEmpty && head && !state.current.currentId) load(head, false)
          resolveNow().catch(note('library')) // files that a restored backup was waiting for may have just arrived
        },
      })
      if (epoch !== libraryEpoch.current) return 0

      for (const o of result.orphanLrc) {
        const n = norm(o.name)
        const lib = state.current.tracks
        const target =
          lib.find((t) => norm(t.file.name) === n || t.title.toLowerCase() === n) ||
          (result.orphanLrc.length === 1 && !result.tracks.length ? lib.find((t) => t.id === state.current.currentId) : null)
        if (target) updateLyrics(target.id, o.lyrics)
      }
      const n = result.tracks.length
      if (result.cancelled) notify(`Import cancelled: ${n} of ${result.total} files added`)
      else if (result.failed) notify(`${result.failed} ${result.failed === 1 ? 'file' : 'files'} could not be read`)
      if (n || result.duplicates) {
        const added = n ? `${n} ${n === 1 ? 'track' : 'tracks'} added` : 'Nothing new'
        announce(result.duplicates ? `${added}, ${result.duplicates} already in your library` : added)
      }
      if (n) void warnIfLow(notify)
      return n
    },
    [load, notify, resolveNow, updateLyrics],
  )

  const addFiles = useCallback(
    (fileList: Iterable<File> | ArrayLike<File>): Promise<number> => {
      const files = Array.from(fileList) // copied at once: the browser empties a FileList when its input is reset
      const controller = new AbortController()
      importAborts.current.add(controller)
      importsPending.current++
      setLoading(true)
      const run = importChain.current.then(async () => ((await hasRoomFor(files)) ? importOne(files, controller.signal, () => controller.abort()) : 0))
      importChain.current = run.catch(() => undefined)
      return run.finally(() => {
        importAborts.current.delete(controller)
        if (--importsPending.current === 0) {
          setLoading(false)
          setImportProgress(null)
        }
      })
    },
    [importOne],
  )

  const cancelImport = useCallback(() => {
    importAborts.current.forEach((controller) => controller.abort())
  }, [])

  /** Take a track out of the library for good: its audio and artwork, its play counts and equalizer, its place in every playlist. */
  const removeFromLibrary = useCallback(
    (id: string) => {
      const s = state.current
      const list = s.tracks
      const t = list.find((x) => x.id === id)
      if (!t) return
      if (id === s.currentId) {
        const el = getEl()
        // move on to what would have played next, in the order playback is following (the library order as a last resort)
        const n = nextAfterRemoval(s.playQueue, id) ?? nextAfterRemoval(list, id)
        if (n) load(n, !el.paused)
        else {
          cancelTransition()
          el.pause()
          el.removeAttribute('src')
          el.load()
          state.current.currentId = null
          setCurrentId(null)
          setTime(0)
          setDuration(0)
        }
      }
      setTracks((l) => l.filter((x) => x.id !== id))
      setPlaylists((l) => l.map((p) => ({ ...p, trackIds: p.trackIds.filter((x) => x !== id) })))
      history.current = history.current.filter((x) => x !== id)
      commitUpNext(s.upNext.filter((x) => x !== id))
      setTrackEq((m) => (m[id] ? Object.fromEntries(Object.entries(m).filter(([key]) => key !== id)) : m))
      resolver.release(id)
      faults.forget(id)
      revokeTrack(t)
      removeTrack(id)
    },
    [cancelTransition, commitUpNext, faults, getEl, load, resolver],
  )

  /** In the library this deletes the track; inside a playlist it only takes the track out of that playlist. */
  const remove = useCallback(
    (id: string) => {
      const s = state.current
      if (s.viewId === 'all') return removeFromLibrary(id)
      setPlaylists((l) => l.map((p) => (p.id === s.viewId ? { ...p, trackIds: p.trackIds.filter((x) => x !== id) } : p)))
    },
    [removeFromLibrary],
  )

  const clear = useCallback(() => {
    // whatever is still being imported or analysed belongs to the library that is about to go
    libraryEpoch.current++
    resume.current = null
    importAborts.current.forEach((controller) => controller.abort())
    upgradeAbort.current?.abort()
    cancelTransition()
    engine.decks.forEach((d) => {
      d.el.pause()
      d.el.removeAttribute('src')
      d.el.load()
    })
    resolver.releaseAll()
    state.current.tracks.forEach(revokeTrack)
    history.current = []
    state.current.currentId = null
    setContext(null)
    commitUpNext([])
    setTracks([])
    setPlaylists((l) => l.map((p) => ({ ...p, trackIds: [] })))
    setCurrentId(null)
    setTime(0)
    setDuration(0)
    setTrackEq({})
    clearTracks(() => state.current.tracks.length === 0) // a retry must not wipe what is imported after this
    saveMeta('resume', null, { quiet: true })
    setLoop(null)
  }, [cancelTransition, commitUpNext, engine, resolver, setLoop])

  const reorder = useCallback((from: number, to: number) => {
    // positions are in the list as shown: in any sort but the stored order they are not positions in what is stored
    if (state.current.sort.key !== 'library') return
    const vid = state.current.viewId
    if (vid === 'all') setTracks((l) => moveItem(l, from, to))
    else setPlaylists((l) => l.map((p) => (p.id === vid ? { ...p, trackIds: moveItem(p.trackIds, from, to) } : p)))
  }, [])

  // ---- playlists ----
  const createPlaylist = useCallback((name?: string, trackIds: string[] = []) => {
    const id = newPlaylistId()
    setPlaylists((l) => [...l, { id, name: cleanName(name ?? ''), trackIds: [...new Set(trackIds)] }])
    return id
  }, [])
  const renamePlaylist = useCallback((id: string, name: string) => {
    setPlaylists((l) => l.map((p) => (p.id === id ? { ...p, name: cleanName(name, p.name) } : p)))
  }, [])
  const duplicatePlaylist = useCallback((id: string): string | null => {
    const source = state.current.playlists.find((p) => p.id === id)
    if (!source) return null
    const copy: Playlist = { id: newPlaylistId(), name: copyName(state.current.playlists.map((p) => p.name), source.name), trackIds: [...source.trackIds] }
    setPlaylists((l) => {
      const at = l.findIndex((p) => p.id === id)
      return at < 0 ? [...l, copy] : [...l.slice(0, at + 1), copy, ...l.slice(at + 1)]
    })
    return copy.id
  }, [])
  const addToPlaylist = useCallback((plId: string, trackId: string) => {
    setPlaylists((l) => l.map((p) => (p.id === plId && !p.trackIds.includes(trackId) ? { ...p, trackIds: [...p.trackIds, trackId] } : p)))
  }, [])
  const addTracksToPlaylist = useCallback((plId: string, trackIds: readonly string[]): number => {
    const pl = state.current.playlists.find((p) => p.id === plId)
    if (!pl) return 0
    const { added } = mergeTrackIds(pl.trackIds, trackIds)
    if (added) setPlaylists((l) => l.map((p) => (p.id === plId ? { ...p, trackIds: [...mergeTrackIds(p.trackIds, trackIds).ids] } : p)))
    return added
  }, [])
  const deletePlaylist = useCallback((id: string): (() => void) | null => {
    const list = state.current.playlists
    const index = list.findIndex((p) => p.id === id)
    const playlist = list[index]
    if (!playlist) return null
    const wasOpen = state.current.viewId === id
    setPlaylists((l) => l.filter((p) => p.id !== id))
    setViewId((v) => (v === id ? 'all' : v))
    // the undo puts it back where it was, with the tracks the library still has by then
    return () => {
      const have = new Set(state.current.tracks.map((t) => t.id))
      setPlaylists((l) => [...restorePlaylist(l, { playlist, index }, (trackId) => have.has(trackId))])
      // and opens it again if it was open, unless the listener has gone to another list since
      if (wasOpen) setViewId((v) => (v === 'all' ? id : v))
    }
  }, [])

  // ---- up next ----
  const knownIds = useCallback((ids: readonly string[]): string[] => {
    const have = new Set(state.current.tracks.map((t) => t.id))
    return keepKnown(ids, (id) => have.has(id))
  }, [])
  const playNext = useCallback(
    (ids: readonly string[]): (() => void) => {
      const added = knownIds(ids)
      commitUpNext(queueNext(state.current.upNext, added))
      return () => commitUpNext(unqueue(state.current.upNext, added, 'front'))
    },
    [commitUpNext, knownIds],
  )
  const addToQueue = useCallback(
    (ids: readonly string[]): (() => void) => {
      const added = knownIds(ids)
      commitUpNext(queueLast(state.current.upNext, added))
      return () => commitUpNext(unqueue(state.current.upNext, added, 'back'))
    },
    [commitUpNext, knownIds],
  )
  const removeFromUpNext = useCallback(
    (index: number): (() => void) => {
      const id = state.current.upNext[index]
      commitUpNext(dequeueAt(state.current.upNext, index))
      return () => {
        if (id !== undefined && knownIds([id]).length) commitUpNext(requeueAt(state.current.upNext, index, id))
      }
    },
    [commitUpNext, knownIds],
  )
  const moveInUpNext = useCallback((from: number, to: number) => commitUpNext(moveQueued(state.current.upNext, from, to)), [commitUpNext])
  const clearUpNext = useCallback((): (() => void) => {
    const before = state.current.upNext
    commitUpNext([])
    return () => commitUpNext(knownIds([...before, ...state.current.upNext]))
  }, [commitUpNext, knownIds])
  const playUpNext = useCallback(
    (index: number) => {
      const id = state.current.upNext[index]
      const t = id ? state.current.tracks.find((x) => x.id === id) : undefined
      if (!t) return
      commitUpNext(dequeueAt(state.current.upNext, index))
      resume.current = resumeAfterQueued(resume.current, state.current.currentId, t.id)
      if (state.current.currentId) history.current.push(state.current.currentId)
      load(t)
    },
    [commitUpNext, load],
  )

  // ---- sort ----
  const setSort = useCallback((spec: SortSpec) => {
    const next = parseSortSpec(spec)
    setSortState((s) => (s.key === next.key && s.dir === next.dir ? s : next))
  }, [])

  // ---- equalizer ----
  // The curve in effect is the current track's own (if it has one), otherwise the shared one. Edits go to whichever applies.
  const trackBands = currentId ? trackEq[currentId] : undefined
  const eqBands = trackBands ?? globalBands
  const eqRemembered = trackBands !== undefined
  // refs let the imperative actions below read the latest values without stale closures
  const bandsRef = useRef(eqBands)
  bandsRef.current = eqBands
  const trackEqRef = useRef(trackEq)
  trackEqRef.current = trackEq
  const eqKeyRef = useRef<string | null>(currentId)
  eqKeyRef.current = currentId
  const presetsRef = useRef(eqPresets)
  presetsRef.current = eqPresets
  const eq = useMemo(() => eqBands.map((b) => b.gain), [eqBands])

  const editBands = useCallback((change: (bands: EqBand[]) => EqBand[]) => {
    const before = bandsRef.current
    const next = change(before)
    if (next === before) return
    bandsRef.current = next
    const id = eqKeyRef.current
    if (id && trackEqRef.current[id]) setTrackEq((m) => ({ ...m, [id]: next }))
    else setGlobalBands(next)
  }, [])

  const setEqBand = useCallback(
    (index: number, gain: number) => {
      const band = bandsRef.current[index]
      if (band) editBands((l) => updateBand(l, band.id, { gain }))
    },
    [editBands],
  )
  const applyPreset = useCallback(
    (name: string) => {
      const preset = EQ_PRESETS[name]
      if (preset) editBands(() => graphicBands(preset))
    },
    [editBands],
  )
  const updateEqBand = useCallback((id: string, patch: Partial<Omit<EqBand, 'id'>>) => editBands((l) => updateBand(l, id, patch)), [editBands])
  const addEqBand = useCallback(
    (band?: Partial<Omit<EqBand, 'id'>>) => {
      const before = bandsRef.current
      editBands((l) => addBand(l, band))
      const after = bandsRef.current
      return after === before ? null : (after[after.length - 1]?.id ?? null)
    },
    [editBands],
  )
  const removeEqBand = useCallback((id: string) => editBands((l) => removeBand(l, id)), [editBands])
  const resetEq = useCallback(() => editBands(() => graphicBands()), [editBands])
  const setEqRemembered = useCallback((on: boolean) => {
    const id = eqKeyRef.current
    if (!id) return
    if (on) {
      const copy = bandsRef.current.map((b) => ({ ...b }))
      setTrackEq((m) => ({ ...m, [id]: copy }))
    } else {
      setTrackEq((m) => Object.fromEntries(Object.entries(m).filter(([key]) => key !== id)))
    }
  }, [])
  const saveEqPreset = useCallback((name: string) => setEqPresets((l) => savePreset(l, name, bandsRef.current)), [])
  const loadEqPreset = useCallback(
    (name: string) => {
      const preset = findPreset(presetsRef.current, name)
      if (preset) editBands(() => preset.bands.map((b) => ({ ...b })))
    },
    [editBands],
  )
  const deleteEqPreset = useCallback((name: string) => setEqPresets((l) => deletePreset(l, name)), [])

  // ---- spatial audio ----
  const setSpatial = useCallback((patch: Partial<SpatialSettings>) => setSpatialState((s) => mergeSpatial(s, patch)), [])

  // ---- reverb ----
  const setReverb = useCallback((patch: Partial<ReverbSettings>) => setReverbState((r) => mergeReverb(r, patch)), [])

  // ---- dynamics, stereo, tone ----
  const setDynamics = useCallback((patch: DynamicsPatch) => setDynamicsState((d) => mergeDynamics(d, patch)), [])
  const setStereo = useCallback((patch: Partial<StereoSettings>) => setStereoState((s) => mergeStereo(s, patch)), [])
  const setTone = useCallback((patch: Partial<ToneSettings>) => setToneState((t) => mergeTone(t, patch)), [])

  // ---- sleep timer ----
  const setSleep = useCallback(
    (min: number | null) => {
      sleep.current = { end: min ? Date.now() + min * 60000 : 0, fading: false }
      engine.restoreMaster()
      setSleepLeft(min ? min * 60 : null)
    },
    [engine],
  )
  const sleeping = sleepLeft !== null
  useEffect(() => {
    if (!sleeping) return undefined
    const id = setInterval(() => {
      const s = sleep.current
      const left = Math.max(0, Math.round((s.end - Date.now()) / 1000))
      if (left <= 0) {
        clearInterval(id)
        cancelTransition()
        engine.decks.forEach((d) => d.el.pause())
        sleep.current = { end: 0, fading: false }
        setSleepLeft(null)
        setTimeout(() => engine.restoreMaster(), 400)
        notify('Sleep timer: playback stopped')
        return
      }
      if (left <= SLEEP_FADE_SECS && !s.fading) {
        s.fading = true
        engine.fadeMaster(0, left)
      }
      setSleepLeft(left)
    }, 1000)
    return () => clearInterval(id)
  }, [sleeping, engine, cancelTransition, notify])

  // progress of decoding the current track
  useEffect(() => resolver.onProgress((id, fraction) => {
    if (id === state.current.currentId) setDecoding(fraction)
  }), [resolver])

  // ---- persistence ----
  const saveResume = useCallback(() => {
    const id = state.current.currentId
    if (!id || !state.current.hydrated || awaitingSrc.current) return
    saveMeta('resume', { id, time: getEl().currentTime || 0 }, { quiet: true })
  }, [getEl])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        // This window claims the library first, so nothing is read that another window is still changing; the code that reads and
        // checks the saved library is fetched meanwhile (see `lib/persist`).
        const [{ loadLibrary }] = await Promise.all([import('../lib/persist/load'), claimWindow()])
        const result = await loadLibrary(normalizeMeta, savedLibrary)
        if (!alive) return
        if (!result.ok) {
          // Nothing may be written over what could not be read: this window plays and browses, and the person is told.
          note('library')(result.error)
          writeGate.memory(result.reason)
          return
        }
        const { library } = result
        const restored = library.records.map((rec) => buildTrack(rec))
        const first = restored[0]
        if (first) {
          state.current.tracks = [...restored, ...state.current.tracks]
          setTracks((l) => [...restored, ...l])
          if (!state.current.currentId) {
            // "Start fresh" leaves out where the last session was: of all that is saved, it is the likeliest cause of a crash at every start
            const resume = safeStart ? null : library.resume
            const start = restored.find((t) => t.id === resume?.id) || first
            load(start, false, resume && resume.id === start.id && resume.time > 1 ? resume.time : null)
          }
        }
        // a playlist made while the library was being read is kept, after the saved ones
        setPlaylists((made) => [...library.playlists, ...made.filter((p) => !library.playlists.some((saved) => saved.id === p.id))])
        setTrackEq(library.trackEq)
        // what was queued by hand before the restart is still queued (whatever was imported meanwhile is added after it), unless the
        // person asked to start fresh. A restored backup that is still waiting for its files is never forgotten that way: it is theirs.
        commitUpNext(keepKnown([...(safeStart ? [] : library.upNext), ...state.current.upNext], () => true))
        const waiting = library.pending ? (await loadBackup()).normalizePending(library.pending) : null
        pendingRef.current = waiting
        setPendingRestore(waiting)
        const damaged = library.skippedRows + library.skippedPlaylists
        if (damaged > 0) {
          // a count and no names: what is damaged is not known to be anyone's file
          note('library')({ name: 'LibraryDamaged', message: `${countLabel(library.skippedRows, 'damaged track')} and ${countLabel(library.skippedPlaylists, 'damaged playlist')} in the saved library were left out` })
          notify(`${countLabel(damaged, 'damaged item')} in your saved library could not be read and ${damaged === 1 ? 'was' : 'were'} left out.`)
        }
        writeGate.open()
      } catch (error) {
        // anything unforeseen: do not write what was never read
        note('library')(error)
        writeGate.memory('unreadable')
      } finally {
        if (alive) setHydrated(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [load, commitUpNext, notify])

  // A library stored before durations, track numbers, genres and formats were read is brought up to date quietly in the
  // background, from the audio copies it already holds. The progress lives in the records (`indexed`), so a restart
  // carries on where this left off.
  useEffect(() => {
    if (!hydrated) return undefined
    const pending = state.current.tracks.filter(needsUpgrade)
    if (!pending.length) return undefined
    const controller = new AbortController()
    upgradeAbort.current = controller
    const epoch = libraryEpoch.current
    let shownAt = 0
    void upgradeLibrary(
      pending.map((t) => ({ id: t.id, file: t.file })),
      {
        signal: controller.signal,
        onProgress: (p) => {
          const now = performance.now()
          if (p.done >= p.total || now - shownAt > 250) {
            shownAt = now
            setUpgradeProgress(p.done >= p.total ? null : { ...p })
          }
        },
        onBatch: (results) => {
          if (epoch !== libraryEpoch.current) return undefined
          const patches = new Map<string, UpgradePatch>()
          for (const t of state.current.tracks) if (results.has(t.id)) patches.set(t.id, upgradePatch(t, results.get(t.id) ?? null))
          if (!patches.size) return undefined
          // rebuilt copies share the object URLs of the tracks they replace, so playback and artwork carry on untouched
          setTracks((l) =>
            l.map((t) => {
              const patch = patches.get(t.id)
              return patch ? buildTrack({ ...toRecord(t), ...patch }, t) : t
            }),
          )
          return patchTracks(patches, { quiet: true }).catch(() => {})
        },
      },
    ).finally(() => setUpgradeProgress(null))
    return () => controller.abort()
  }, [hydrated])

  // the player re-renders several times a second: the id list is rebuilt only when the library itself changes
  const orderKey = useMemo(() => tracks.map((t) => t.id).join(','), [tracks])
  useEffect(() => {
    if (hydrated) saveMeta('order', tracks.map((t) => t.id))
  }, [hydrated, orderKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (hydrated) saveMeta('playlists', playlists)
  }, [hydrated, playlists])
  useEffect(() => {
    if (hydrated) saveMeta('trackEq', trackEq)
  }, [hydrated, trackEq])
  useEffect(() => {
    if (hydrated) saveMeta('pendingRestore', pendingRestore)
  }, [hydrated, pendingRestore])
  useEffect(() => {
    if (hydrated) saveMeta('upNext', [...upNext])
  }, [hydrated, upNext])
  // a restore that was left waiting last session may be satisfiable now (files were added while it was not loaded)
  useEffect(() => {
    if (hydrated) resolveNow().catch(note('library'))
  }, [hydrated, resolveNow])
  useEffect(() => {
    if (viewId !== 'all' && !isSmartId(viewId) && !playlists.some((p) => p.id === viewId)) setViewId('all')
  }, [viewId, playlists])
  useEffect(() => {
    saveResume()
  }, [currentId, saveResume])
  useEffect(() => {
    if (!playing) return undefined
    const id = setInterval(saveResume, 5000)
    const onHide = () => saveResume()
    window.addEventListener('pagehide', onHide)
    return () => {
      clearInterval(id)
      window.removeEventListener('pagehide', onHide)
    }
  }, [playing, saveResume])
  useEffect(() => {
    const settings: Settings = { volume, muted, repeat, shuffle, transition, eqBands: globalBands, eqPresets, eqOn, speed, preservePitch, normalize, spatial, reverb, dynamics, stereo, tone, sort }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch (error) {
      note('save')(error) // the settings are not remembered until there is room again
    }
  }, [volume, muted, repeat, shuffle, transition, globalBands, eqPresets, eqOn, speed, preservePitch, normalize, spatial, reverb, dynamics, stereo, tone, sort])

  // a changed queue invalidates any preloaded "next" pick
  useEffect(() => {
    if (!xfade.current.active) xfade.current.pending = null
  }, [playQueue, upNext, shuffle, repeat])

  // ---- audio element events (both decks; only the active one drives the UI) ----
  useEffect(() => {
    const isActive = (e: Event) => e.target === getEl()
    const onTime = (e: Event) => {
      if (!isActive(e)) return
      const el = getEl()
      setTime(el.currentTime)
      const s = state.current
      if (s.currentId && tally.current.observe(s.currentId, el.currentTime, el.duration, !el.paused)) recordPlay(s.currentId)
      if (stepLoop()) return // a loop holds the track: nothing is preloaded and no transition starts while it goes round
      const mode = s.transition
      if (mode === 'off' || s.repeat === 'one' || !Number.isFinite(el.duration)) return
      const x = xfade.current
      if (x.active) return
      const remaining = el.duration - el.currentTime
      if (remaining <= 15 && !x.pending) {
        const n = pickNext(1, true, false) // looking ahead: the queue is not used up until the track really starts
        if (n && faults.canPreload(n.id)) {
          x.pending = n
          const idle = otherDeck(active.current)
          const o = engine.decks[idle].el
          resolver.retain([state.current.currentId ?? '', n.id])
          const preloadSrc = resolver.urlFor(n)
          if (preloadSrc) {
            if (o.getAttribute('src') !== preloadSrc) {
              o.src = preloadSrc
              faults.attach(idle, n.id, preloadSrc)
              o.load()
            }
          } else {
            // WAV/FLAC that needs a look or a decode: start it now so it is ready by the time this track ends
            resolver
              .resolve(n)
              .then((url) => {
                if (x.pending?.id === n.id && o.getAttribute('src') !== url) {
                  o.src = url
                  faults.attach(idle, n.id, url)
                  o.load()
                }
              })
              .catch(() => {})
          }
          applyNorm(idle, n) // pre-compute the next track's gain while the current one plays
        }
      }
      const lead = mode === 'crossfade' ? Math.min(XFADE_SECS, el.duration / 2) : 0.4
      if (remaining <= lead && x.pending) {
        if (mode === 'crossfade') beginTransition('crossfade')
        else if (!x.timer) {
          x.timer = setTimeout(() => {
            x.timer = null
            beginTransition('gapless')
          }, Math.max(0, (remaining - 0.03) * 1000))
        }
      }
    }
    const onMeta = (e: Event) => {
      if (!isActive(e)) return
      const el = getEl()
      const d = el.duration
      setDuration(Number.isFinite(d) ? d : 0)
      if (Number.isFinite(d) && d > 0) {
        // the file can be read: the run of tracks that could not be played ends here, and is counted. A track that is only being made
        // ready, not played, ends it too; one that can be read but not decoded ends it as well, and is named like a new run's first.
        const skipped = faults.progress()
        if (skipped > 1) notify(`Skipped ${skipped} tracks that could not be played.`)
      }
      if (pendingSeek.current != null && Number.isFinite(d)) {
        el.currentTime = Math.min(pendingSeek.current, d)
        pendingSeek.current = null
        setTime(el.currentTime)
      }
      const id = state.current.currentId
      if (id && Number.isFinite(d)) {
        // what the browser reports is what the seek bar uses: learn it, and keep it (an estimate from a header-less
        // file is replaced by the real length the first time the file is played)
        const known = state.current.tracks.find((t) => t.id === id)
        if (known && Math.abs((known.duration || 0) - d) > 0.5) {
          setTracks((l) => l.map((t) => (t.id === id ? { ...t, duration: d } : t)))
          patchTracks(new Map([[id, { duration: d }]]), { quiet: true }).catch(() => {})
        }
      }
    }
    const onPlay = (e: Event) => {
      if (!isActive(e)) return
      setPlaying(true)
    }
    const onPause = (e: Event) => {
      if (!isActive(e)) return
      playIntent.current = false
      setPlaying(false)
      saveResume()
    }
    const onEnd = (e: Event) => {
      if (!isActive(e)) return
      const held = state.current.loop
      if (held) {
        // only a playhead that was moved past the end of the loop, to the end of the file, gets here: the loop goes round again
        const el = getEl()
        el.currentTime = held.a
        tally.current.jumped()
        startPlay(el)
        return
      }
      const endedId = state.current.currentId
      if (endedId && tally.current.finish(getEl().duration)) recordPlay(endedId)
      tally.current.begin(null) // whatever plays next (even the same track again) is a new listen
      if (state.current.repeat === 'one') {
        const el = getEl()
        el.currentTime = 0
        startPlay(el)
      } else next(true)
    }
    // either deck: the one that is not playing may have been lined up with a file that cannot be played (see `failedSource`)
    const onErr = (e: Event) => {
      const deck = engine.decks.findIndex((d) => d.el === e.target)
      if (deck === 0 || deck === 1) failedSource(deck)
    }
    const bound = engine.decks.map((d) => {
      const el = d.el
      el.addEventListener('timeupdate', onTime)
      el.addEventListener('loadedmetadata', onMeta)
      el.addEventListener('durationchange', onMeta)
      el.addEventListener('play', onPlay)
      el.addEventListener('pause', onPause)
      el.addEventListener('ended', onEnd)
      el.addEventListener('error', onErr)
      return el
    })
    return () => {
      bound.forEach((el) => {
        el.removeEventListener('timeupdate', onTime)
        el.removeEventListener('loadedmetadata', onMeta)
        el.removeEventListener('durationchange', onMeta)
        el.removeEventListener('play', onPlay)
        el.removeEventListener('pause', onPause)
        el.removeEventListener('ended', onEnd)
        el.removeEventListener('error', onErr)
      })
    }
  }, [engine, faults, failedSource, getEl, next, notify, pickNext, beginTransition, saveResume, startPlay, applyNorm, resolver, recordPlay, stepLoop])

  // toggling normalization re-applies (or clears) the gain on the active deck
  useEffect(() => {
    if (!normalize) {
      engine.setNorm(0, 1)
      engine.setNorm(1, 1)
      return
    }
    applyNorm(active.current, state.current.tracks.find((t) => t.id === state.current.currentId))
  }, [engine, normalize, applyNorm])

  useEffect(() => {
    engine.decks.forEach((d) => {
      d.el.volume = volume
      d.el.muted = muted
    })
  }, [engine, volume, muted])

  // defaultPlaybackRate survives the media load algorithm that runs on every src change
  useEffect(() => {
    engine.decks.forEach((d) => {
      const el: PitchAudio = d.el
      el.defaultPlaybackRate = speed
      el.playbackRate = speed
      el.preservesPitch = preservePitch
      el.mozPreservesPitch = preservePitch
      el.webkitPreservesPitch = preservePitch
    })
  }, [engine, speed, preservePitch])

  useEffect(() => {
    engine.setEqBands(eqBands)
    engine.setEqEnabled(eqOn)
  }, [engine, eqBands, eqOn])

  useEffect(() => {
    engine.setSpatial(spatial)
  }, [engine, spatial])

  useEffect(() => {
    engine.setReverb(reverb)
  }, [engine, reverb])

  useEffect(() => {
    engine.setDynamics(dynamics)
  }, [engine, dynamics])

  useEffect(() => {
    engine.setStereo(stereo)
  }, [engine, stereo])

  useEffect(() => {
    engine.setTone(tone)
  }, [engine, tone])

  // ---- Media Session: lock screen, notification shade, remote / TV media keys ----
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    if (!current) {
      ms.metadata = null
      ms.playbackState = 'none'
      return
    }
    const base = import.meta.env.BASE_URL
    const fallback = [
      { src: `${base}icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
      { src: `${base}icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
    ]
    try {
      ms.metadata = new MediaMetadata({
        title: current.title,
        artist: current.artist,
        album: current.album || 'Wavelocal',
        artwork: current.cover ? [{ src: current.cover, sizes: '512x512' }, ...fallback] : fallback,
      })
    } catch {
      /* unsupported artwork */
    }
  }, [current])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    const set = (action: MediaSessionAction, fn: MediaSessionActionHandler) => {
      try {
        ms.setActionHandler(action, fn)
      } catch {
        /* action unsupported on this platform */
      }
    }
    set('play', () => {
      startPlay(getEl())
    })
    set('pause', () => getEl().pause())
    set('stop', () => getEl().pause())
    set('previoustrack', () => prev())
    set('nexttrack', () => next(false))
    set('seekbackward', (d) => seekBy(-(d.seekOffset || mediaSkip.back)))
    set('seekforward', (d) => seekBy(d.seekOffset || mediaSkip.forward))
    set('seekto', (d) => {
      if (d.seekTime != null) seek(d.seekTime)
    })
  }, [getEl, startPlay, prev, next, seek, seekBy])

  useEffect(() => {
    if (!('mediaSession' in navigator) || !currentId) return
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
    try {
      if (Number.isFinite(duration) && duration > 0)
        navigator.mediaSession.setPositionState({ duration, playbackRate: getEl().playbackRate || 1, position: Math.min(getEl().currentTime, duration) })
    } catch {
      /* ignore invalid state */
    }
  }, [getEl, currentId, playing, duration, current?.title, current?.artist, current?.album, current?.cover])

  return {
    engine, tracks, queue, playQueue, playlists, viewId, setViewId, sort, setSort, current, currentId, playing, time, duration, volume, muted,
    repeat, shuffle, transition, setTransition, speed, setSpeed: (v) => setSpeedState(clamp(Math.round(v * 20) / 20, 0.5, 2)), preservePitch, setPreservePitch, normalize, setNormalize, eq, eqOn, setEqOn, setEqBand, applyPreset, eqBands, updateEqBand, addEqBand, removeEqBand, resetEq, eqRemembered, setEqRemembered, eqPresets, saveEqPreset, loadEqPreset, deleteEqPreset, spatial, setSpatial, reverb, setReverb, dynamics, setDynamics, stereo, setStereo, tone, setTone, sleepLeft, setSleep,
    upNext: upNextTracks, playNext, addToQueue, removeFromUpNext, moveInUpNext, clearUpNext, playUpNext,
    loading, importProgress, cancelImport, upgradeProgress, hydrated, decoding,
    play, playFrom, toggle, next: () => next(false), prev, seek, position: () => getEl().currentTime, seekBy, loop, setLoop, setVolume, volumeBy, toggleMute,
    cycleRepeat, toggleShuffle, addFiles, attachLrc, editTags, remove, removeFromLibrary, clear, reorder,
    createPlaylist, addToPlaylist, addTracksToPlaylist, renamePlaylist, duplicatePlaylist, deletePlaylist, resetPlays,
    exportBackup, previewBackup, applyBackup, pendingRestoreCount: pendingRestore?.tracks.length ?? 0, discardPendingRestore,
  }
}
