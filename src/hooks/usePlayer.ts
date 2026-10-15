import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AudioEngine, EQ_PRESETS } from '../lib/engine'
import * as db from '../lib/db'
import { estimateGainDb } from '../lib/loudness'
import { buildTrack, filesToTracks, lrcFromFile, norm, revokeTrack } from '../lib/metadata'
import { moveItem, nextRepeat, pickTrack, resolveQueue } from '../lib/queue'
import type { EqGains, Lyrics, PlayerApi, Playlist, RepeatMode, Settings, Track, TransitionMode } from '../types'

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))
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
  queue: Track[]
  playlists: Playlist[]
  viewId: string
  currentId: string | null
  repeat: RepeatMode
  shuffle: boolean
  transition: TransitionMode
  normalize: boolean
  hydrated: boolean
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

/** Owns the audio engine (two decks, EQ, analyser) plus queue, playlists, persistence and playback state. */
export function usePlayer(): PlayerApi {
  const [engine] = useState(() => new AudioEngine())
  const [saved] = useState(loadSettings)

  const [tracks, setTracks] = useState<Track[]>([]) // the whole library
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [viewId, setViewId] = useState('all')
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState(saved.volume ?? 0.8)
  const [muted, setMuted] = useState(saved.muted ?? false)
  const [repeat, setRepeat] = useState<RepeatMode>(saved.repeat ?? 'off')
  const [shuffle, setShuffle] = useState(saved.shuffle ?? false)
  const [transition, setTransition] = useState<TransitionMode>(saved.transition ?? 'off')
  const [eq, setEq] = useState<EqGains>(Array.isArray(saved.eq) && saved.eq.length === 10 ? saved.eq : (EQ_PRESETS.Flat ?? new Array<number>(10).fill(0)))
  const [eqOn, setEqOn] = useState(saved.eqOn ?? true)
  const [speed, setSpeedState] = useState(clamp(saved.speed ?? 1, 0.5, 2))
  const [preservePitch, setPreservePitch] = useState(saved.preservePitch ?? true)
  const [normalize, setNormalize] = useState(saved.normalize ?? false)
  const [sleepLeft, setSleepLeft] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [hydrated, setHydrated] = useState(false)

  const active = useRef<DeckIndex>(0) // index of the deck the user is hearing
  const history = useRef<string[]>([])
  const xfade = useRef<CrossfadeState>({ timer: null, active: false, pending: null })
  const sleep = useRef({ end: 0, fading: false })
  const pendingSeek = useRef<number | null>(null)
  const noticeTimer = useRef<Timer | undefined>(undefined)
  const state = useRef<Snapshot>({
    tracks: [],
    queue: [],
    playlists: [],
    viewId: 'all',
    currentId: null,
    repeat,
    shuffle,
    transition,
    normalize,
    hydrated: false,
  })

  const queue = useMemo(() => resolveQueue(tracks, playlists, viewId), [tracks, playlists, viewId])

  state.current = { ...state.current, tracks, queue, playlists, viewId, currentId: state.current.currentId ?? currentId, repeat, shuffle, transition, normalize, hydrated }
  const current = useMemo(() => tracks.find((t) => t.id === currentId) || null, [tracks, currentId])

  const getEl = useCallback(() => engine.decks[active.current].el, [engine])

  const notify = useCallback((msg: string) => {
    setNotice(msg)
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(''), 4500)
  }, [])

  const startPlay = useCallback(
    (el: HTMLAudioElement) => {
      engine.init()
      return el.play().catch(() => setPlaying(false))
    },
    [engine],
  )

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
        db.putTracks([{ ...latest, gainDb: g }]).catch(() => {})
        if (state.current.normalize && engine.decks[deckIdx].el.getAttribute('src') === track.url) engine.setNorm(deckIdx, 10 ** (g / 20))
      })
    },
    [engine],
  )

  const load = useCallback(
    (track: Track | null | undefined, autoplay = true) => {
      if (!track) return
      cancelTransition()
      const el = getEl()
      el.src = track.url
      applyNorm(active.current, track)
      state.current.currentId = track.id
      setCurrentId(track.id)
      setTime(0)
      setDuration(track.duration || 0)
      if (autoplay) startPlay(el)
    },
    [applyNorm, cancelTransition, getEl, startPlay],
  )

  const pickNext = useCallback((dir: 1 | -1, auto: boolean): Track | null => {
    const { queue: list, currentId, repeat: rep, shuffle: shuf } = state.current
    const picked = pickTrack({ queue: list, currentId, repeat: rep, shuffle: shuf, history: history.current, dir, auto })
    history.current = [...picked.history]
    return picked.track
  }, [])

  /** Start the next track on the idle deck (overlapping for crossfade, immediate for gapless). */
  const beginTransition = useCallback(
    (mode: 'crossfade' | 'gapless') => {
      const x = xfade.current
      if (x.active) return
      const s = state.current
      const pend = x.pending
      const nextT = (pend && s.queue.find((t) => t.id === pend.id)) || pickNext(1, true)
      if (!nextT) return
      const cur = active.current
      const nxt = otherDeck(cur)
      const outEl = engine.decks[cur].el
      const inEl = engine.decks[nxt].el
      const hasCtx = engine.init()
      const secs = mode === 'crossfade' && hasCtx ? clamp((outEl.duration || 0) / 2, 1, XFADE_SECS) : 0
      if (inEl.getAttribute('src') !== nextT.url) inEl.src = nextT.url
      applyNorm(nxt, nextT)
      inEl.currentTime = 0
      if (hasCtx) engine.setGain(nxt, secs ? 0 : 1)
      inEl.play().catch(() => {})
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
    [engine, pickNext, applyNorm],
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
      if (id === state.current.currentId) {
        startPlay(getEl())
        return
      }
      if (state.current.currentId) history.current.push(state.current.currentId)
      load(t)
    },
    [getEl, load, startPlay],
  )

  const toggle = useCallback(() => {
    if (!state.current.currentId) {
      const first = state.current.queue[0]
      if (first) load(first)
      return
    }
    const el = getEl()
    if (el.paused) startPlay(el)
    else el.pause()
  }, [getEl, load, startPlay])

  const seek = useCallback(
    (t: number) => {
      const el = getEl()
      if (!Number.isFinite(el.duration)) return
      el.currentTime = clamp(t, 0, el.duration)
      setTime(el.currentTime)
    },
    [getEl],
  )
  const seekBy = useCallback((d: number) => seek(getEl().currentTime + d), [getEl, seek])

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
    if (t) db.putTracks([{ ...t, lyrics }]).catch(() => {})
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

  // ---- library ----
  const addFiles = useCallback(
    async (fileList: Iterable<File> | ArrayLike<File>) => {
      setLoading(true)
      try {
        const existing = new Set(state.current.tracks.map((t) => t.key))
        const { tracks: added, orphanLrc } = await filesToTracks(fileList, existing)
        const first = added[0]
        if (first) {
          const wasEmpty = state.current.tracks.length === 0
          state.current.tracks = [...state.current.tracks, ...added]
          setTracks((l) => [...l, ...added])
          setViewId('all')
          db.putTracks(added).catch(() => notify('Could not save to the offline library (storage blocked or full)'))
          navigator.storage?.persist?.().catch?.(() => {})
          if (wasEmpty && !state.current.currentId) load(first, false)
        }
        for (const o of orphanLrc) {
          const n = norm(o.name)
          const lib = state.current.tracks
          const target =
            lib.find((t) => norm(t.file.name) === n || t.title.toLowerCase() === n) ||
            (orphanLrc.length === 1 && !added.length ? lib.find((t) => t.id === state.current.currentId) : null)
          if (target) updateLyrics(target.id, o.lyrics)
        }
        return added.length
      } finally {
        setLoading(false)
      }
    },
    [load, notify, updateLyrics],
  )

  const remove = useCallback(
    (id: string) => {
      const s = state.current
      if (s.viewId !== 'all') {
        setPlaylists((l) => l.map((p) => (p.id === s.viewId ? { ...p, trackIds: p.trackIds.filter((x) => x !== id) } : p)))
        return
      }
      const list = s.tracks
      const t = list.find((x) => x.id === id)
      if (!t) return
      if (id === s.currentId) {
        const el = getEl()
        const n = list.length > 1 ? (list[(list.indexOf(t) + 1) % list.length] ?? null) : null
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
      revokeTrack(t)
      db.deleteTrack(id).catch(() => {})
    },
    [cancelTransition, getEl, load],
  )

  const clear = useCallback(() => {
    cancelTransition()
    engine.decks.forEach((d) => {
      d.el.pause()
      d.el.removeAttribute('src')
      d.el.load()
    })
    state.current.tracks.forEach(revokeTrack)
    history.current = []
    state.current.currentId = null
    setTracks([])
    setPlaylists((l) => l.map((p) => ({ ...p, trackIds: [] })))
    setCurrentId(null)
    setTime(0)
    setDuration(0)
    db.clearTracks().catch(() => {})
    db.setMeta('resume', null).catch(() => {})
  }, [cancelTransition, engine])

  const reorder = useCallback((from: number, to: number) => {
    const vid = state.current.viewId
    if (vid === 'all') setTracks((l) => moveItem(l, from, to))
    else setPlaylists((l) => l.map((p) => (p.id === vid ? { ...p, trackIds: moveItem(p.trackIds, from, to) } : p)))
  }, [])

  // ---- playlists ----
  const createPlaylist = useCallback((name?: string, trackIds: string[] = []) => {
    const id = `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    setPlaylists((l) => [...l, { id, name: (name || '').trim() || 'New playlist', trackIds }])
    return id
  }, [])
  const addToPlaylist = useCallback((plId: string, trackId: string) => {
    setPlaylists((l) => l.map((p) => (p.id === plId && !p.trackIds.includes(trackId) ? { ...p, trackIds: [...p.trackIds, trackId] } : p)))
  }, [])
  const deletePlaylist = useCallback((id: string) => {
    setPlaylists((l) => l.filter((p) => p.id !== id))
    setViewId((v) => (v === id ? 'all' : v))
  }, [])

  // ---- equalizer ----
  const setEqBand = useCallback((i: number, v: number) => setEq((l) => l.map((x, k) => (k === i ? v : x))), [])
  const applyPreset = useCallback((name: string) => {
    const preset = EQ_PRESETS[name]
    if (preset) setEq(preset.slice())
  }, [])

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

  // ---- persistence ----
  const saveResume = useCallback(() => {
    const id = state.current.currentId
    if (!id || !state.current.hydrated) return
    db.setMeta('resume', { id, time: getEl().currentTime || 0 }).catch(() => {})
  }, [getEl])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [rows, order, pls, resume] = await Promise.all([db.getAllTracks(), db.getMeta('order'), db.getMeta('playlists'), db.getMeta('resume')])
        if (!alive) return
        const ids = Array.isArray(order) ? order : []
        const byId = new Map(rows.map((r) => [r.id, r]))
        const ordered = [
          ...ids.flatMap((i) => {
            const r = byId.get(i)
            return r ? [r] : []
          }),
          ...rows.filter((r) => !ids.includes(r.id)),
        ]
        const restored = ordered.map((rec) => buildTrack(rec))
        const first = restored[0]
        if (first) {
          state.current.tracks = [...restored, ...state.current.tracks]
          setTracks((l) => [...restored, ...l])
          if (!state.current.currentId) {
            const start = restored.find((t) => t.id === resume?.id) || first
            if (resume && resume.id === start.id && resume.time > 1) pendingSeek.current = resume.time
            load(start, false)
          }
        }
        if (Array.isArray(pls)) setPlaylists(pls)
      } catch {
        /* no persistent storage available: run in-memory */
      } finally {
        if (alive) setHydrated(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [load])

  const orderKey = tracks.map((t) => t.id).join(',')
  useEffect(() => {
    if (hydrated) db.setMeta('order', tracks.map((t) => t.id)).catch(() => {})
  }, [hydrated, orderKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (hydrated) db.setMeta('playlists', playlists).catch(() => {})
  }, [hydrated, playlists])
  useEffect(() => {
    if (viewId !== 'all' && !playlists.some((p) => p.id === viewId)) setViewId('all')
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
    const settings: Settings = { volume, muted, repeat, shuffle, transition, eq, eqOn, speed, preservePitch, normalize }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      /* ignore */
    }
  }, [volume, muted, repeat, shuffle, transition, eq, eqOn, speed, preservePitch, normalize])

  // a changed queue invalidates any preloaded "next" pick
  useEffect(() => {
    if (!xfade.current.active) xfade.current.pending = null
  }, [queue, shuffle, repeat])

  // ---- audio element events (both decks; only the active one drives the UI) ----
  useEffect(() => {
    const isActive = (e: Event) => e.target === getEl()
    const onTime = (e: Event) => {
      if (!isActive(e)) return
      const el = getEl()
      setTime(el.currentTime)
      const s = state.current
      const mode = s.transition
      if (mode === 'off' || s.repeat === 'one' || !Number.isFinite(el.duration)) return
      const x = xfade.current
      if (x.active) return
      const remaining = el.duration - el.currentTime
      if (remaining <= 15 && !x.pending) {
        const n = pickNext(1, true)
        if (n) {
          x.pending = n
          const idle = otherDeck(active.current)
          const o = engine.decks[idle].el
          if (o.getAttribute('src') !== n.url) {
            o.src = n.url
            o.load()
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
      if (pendingSeek.current != null && Number.isFinite(d)) {
        el.currentTime = Math.min(pendingSeek.current, d)
        pendingSeek.current = null
        setTime(el.currentTime)
      }
      const id = state.current.currentId
      if (id && Number.isFinite(d)) setTracks((l) => l.map((t) => (t.id === id && !t.duration ? { ...t, duration: d } : t)))
    }
    const onPlay = (e: Event) => {
      if (isActive(e)) setPlaying(true)
    }
    const onPause = (e: Event) => {
      if (!isActive(e)) return
      setPlaying(false)
      saveResume()
    }
    const onEnd = (e: Event) => {
      if (!isActive(e)) return
      if (state.current.repeat === 'one') {
        const el = getEl()
        el.currentTime = 0
        startPlay(el)
      } else next(true)
    }
    const onErr = (e: Event) => {
      if (isActive(e) && getEl().getAttribute('src')) next(true)
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
  }, [engine, getEl, next, pickNext, beginTransition, saveResume, startPlay, applyNorm])

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
    engine.setEq(eq)
    engine.setEqEnabled(eqOn)
  }, [engine, eq, eqOn])

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
    set('seekbackward', (d) => seekBy(-(d.seekOffset || 10)))
    set('seekforward', (d) => seekBy(d.seekOffset || 10))
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
  }, [getEl, currentId, playing, duration])

  return {
    engine, tracks, queue, playlists, viewId, setViewId, current, currentId, playing, time, duration, volume, muted,
    repeat, shuffle, transition, setTransition, speed, setSpeed: (v) => setSpeedState(clamp(Math.round(v * 20) / 20, 0.5, 2)), preservePitch, setPreservePitch, normalize, setNormalize, eq, eqOn, setEqOn, setEqBand, applyPreset, sleepLeft, setSleep,
    loading, notice, hydrated,
    play, toggle, next: () => next(false), prev, seek, seekBy, setVolume, volumeBy, toggleMute,
    cycleRepeat, toggleShuffle, addFiles, attachLrc, remove, clear, reorder,
    createPlaylist, addToPlaylist, deletePlaylist,
  }
}
