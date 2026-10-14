import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { filesToTracks, revokeTrack } from '../lib/metadata'

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

/** Owns the <audio> element and all queue / playback state. */
export function usePlayer() {
  const audioRef = useRef(null)
  if (!audioRef.current && typeof Audio !== 'undefined') audioRef.current = new Audio()
  const audio = audioRef.current

  const [tracks, setTracks] = useState([])
  const [currentId, setCurrentId] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState(0.8)
  const [muted, setMuted] = useState(false)
  const [repeat, setRepeat] = useState('off') // off | all | one
  const [shuffle, setShuffle] = useState(false)
  const [loading, setLoading] = useState(false)

  const history = useRef([])
  const state = useRef({})
  state.current = { tracks, currentId, repeat, shuffle }

  const current = useMemo(() => tracks.find((t) => t.id === currentId) || null, [tracks, currentId])

  const load = useCallback(
    (track, autoplay = true) => {
      if (!track) return
      audio.src = track.url
      audio.currentTime = 0
      state.current.currentId = track.id
      setCurrentId(track.id)
      setTime(0)
      setDuration(track.duration || 0)
      if (autoplay) audio.play().catch(() => setPlaying(false))
    },
    [audio],
  )

  const pickNext = useCallback((dir, auto) => {
    const { tracks: list, currentId: id, repeat: rep, shuffle: shuf } = state.current
    if (!list.length) return null
    const idx = list.findIndex((t) => t.id === id)
    if (dir < 0) {
      if (history.current.length && shuf) {
        const prevId = history.current.pop()
        return list.find((t) => t.id === prevId) || list[0]
      }
      return list[(idx - 1 + list.length) % list.length]
    }
    if (shuf && list.length > 1) {
      let n
      do n = list[Math.floor(Math.random() * list.length)]
      while (n.id === id)
      return n
    }
    if (idx === list.length - 1) return auto && rep !== 'all' ? null : list[0]
    return list[idx + 1]
  }, [])

  const next = useCallback(
    (auto = false) => {
      const t = pickNext(1, auto)
      if (!t) {
        audio.pause()
        audio.currentTime = 0
        return
      }
      if (state.current.currentId) history.current.push(state.current.currentId)
      load(t)
    },
    [audio, load, pickNext],
  )

  const prev = useCallback(() => {
    if (audio.currentTime > 3) {
      audio.currentTime = 0
      return
    }
    const t = pickNext(-1, false)
    if (t) load(t)
  }, [audio, load, pickNext])

  const play = useCallback(
    (id) => {
      const t = state.current.tracks.find((x) => x.id === id)
      if (!t) return
      if (id === state.current.currentId) {
        audio.play().catch(() => {})
        return
      }
      if (state.current.currentId) history.current.push(state.current.currentId)
      load(t)
    },
    [audio, load],
  )

  const toggle = useCallback(() => {
    if (!state.current.currentId) {
      const first = state.current.tracks[0]
      if (first) load(first)
      return
    }
    if (audio.paused) audio.play().catch(() => {})
    else audio.pause()
  }, [audio, load])

  const seek = useCallback(
    (t) => {
      if (!Number.isFinite(audio.duration)) return
      audio.currentTime = clamp(t, 0, audio.duration)
      setTime(audio.currentTime)
    },
    [audio],
  )
  const seekBy = useCallback((d) => seek(audio.currentTime + d), [audio, seek])

  const setVolume = useCallback((v) => {
    const nv = clamp(v, 0, 1)
    setVolumeState(nv)
    setMuted(nv === 0)
  }, [])
  const volumeBy = useCallback((d) => {
    setVolumeState((v) => clamp(Math.round((v + d) * 100) / 100, 0, 1))
    setMuted(false)
  }, [])
  const toggleMute = useCallback(() => {
    if (muted && volume === 0) setVolumeState(0.5)
    setMuted(!muted)
  }, [muted, volume])

  const cycleRepeat = useCallback(() => setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off')), [])
  const toggleShuffle = useCallback(() => setShuffle((s) => !s), [])

  const addFiles = useCallback(
    async (fileList) => {
      setLoading(true)
      try {
        const added = await filesToTracks(fileList)
        if (!added.length) return 0
        const wasEmpty = state.current.tracks.length === 0
        setTracks((l) => [...l, ...added])
        if (wasEmpty) {
          state.current.tracks = added
          load(added[0], false)
        }
        return added.length
      } finally {
        setLoading(false)
      }
    },
    [load],
  )

  const remove = useCallback(
    (id) => {
      const { tracks: list, currentId: cur } = state.current
      const t = list.find((x) => x.id === id)
      if (!t) return
      if (id === cur) {
        const n = list.length > 1 ? list[(list.indexOf(t) + 1) % list.length] : null
        if (n) load(n, !audio.paused)
        else {
          audio.pause()
          audio.removeAttribute('src')
          audio.load()
          setCurrentId(null)
          setTime(0)
          setDuration(0)
        }
      }
      setTracks((l) => l.filter((x) => x.id !== id))
      history.current = history.current.filter((x) => x !== id)
      revokeTrack(t)
    },
    [audio, load],
  )

  const clear = useCallback(() => {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    state.current.tracks.forEach(revokeTrack)
    history.current = []
    setTracks([])
    setCurrentId(null)
    setTime(0)
    setDuration(0)
  }, [audio])

  const reorder = useCallback((from, to) => {
    setTracks((l) => {
      if (from === to || from < 0 || to < 0 || from >= l.length || to >= l.length) return l
      const c = l.slice()
      c.splice(to, 0, c.splice(from, 1)[0])
      return c
    })
  }, [])

  // audio element events
  useEffect(() => {
    const onTime = () => setTime(audio.currentTime)
    const onMeta = () => {
      setDuration(audio.duration || 0)
      const id = state.current.currentId
      if (id && Number.isFinite(audio.duration))
        setTracks((l) => l.map((t) => (t.id === id && !t.duration ? { ...t, duration: audio.duration } : t)))
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnd = () => {
      if (state.current.repeat === 'one') {
        audio.currentTime = 0
        audio.play().catch(() => {})
      } else next(true)
    }
    const onErr = () => {
      if (audio.getAttribute('src')) next(true)
    }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('durationchange', onMeta)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnd)
    audio.addEventListener('error', onErr)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('durationchange', onMeta)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnd)
      audio.removeEventListener('error', onErr)
    }
  }, [audio, next])

  useEffect(() => {
    audio.volume = volume
    audio.muted = muted
  }, [audio, volume, muted])

  // OS-level media keys / lock screen controls
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    if (!current) {
      ms.metadata = null
      return
    }
    ms.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist,
      album: current.album,
      artwork: current.cover ? [{ src: current.cover }] : [],
    })
    ms.setActionHandler('play', toggle)
    ms.setActionHandler('pause', toggle)
    ms.setActionHandler('previoustrack', prev)
    ms.setActionHandler('nexttrack', () => next(false))
  }, [current, toggle, prev, next])

  return {
    tracks, current, currentId, playing, time, duration, volume, muted, repeat, shuffle, loading,
    play, toggle, next: () => next(false), prev, seek, seekBy, setVolume, volumeBy, toggleMute,
    cycleRepeat, toggleShuffle, addFiles, remove, clear, reorder,
  }
}
