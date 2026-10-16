/**
 * Listen-together session logic: who is hosting, who has joined, what each side does when the other speaks.
 *
 * Host: owns the music. Every few hundred milliseconds it compares the real playhead with what guests already expect
 * (`broadcastReason`) and sends a fresh `state` only when something changed or as a heartbeat. It serves the current
 * and the next track to guests that ask for them, and nothing else from the library.
 *
 * Guest: follows. It turns each `state` into the right track, play/pause and position (`planGuest`), using a clock
 * offset measured with ping/pong so the position is the host's position "now" rather than "when the packet left".
 * A track it does not own is requested over the file channel, verified, and saved to the library like any import.
 *
 * Loaded lazily (see `store.ts`); nothing here runs until someone starts or joins a session.
 */
import { fileKey } from '../metadata'
import type { Track } from '../../types'
import { ClockSync, sampleFrom } from './clock'
import { PeerLink, webRtcAvailable } from './peer'
import { LIMITS, PROTOCOL_VERSION, cleanText, encodeFileFrame } from './protocol'
import type { CtlMessage, RemoteCommand, TrackMeta } from './protocol'
import { decodeSignal } from './signal'
import { currentPlayer, getShareSnapshot, publishShare, resetShare } from './store'
import type { PeerStatus, PeerView } from './store'
import { broadcastReason, planGuest } from './sync'
import type { Announcement, HostPlayback } from './sync'
import { FileReceiver, TransferAborted, sendFile } from './transfer'

type StateMessage = Extract<CtlMessage, { t: 'state' }>

const MAX_GUESTS = 6
const HOST_TICK_MS = 250
const GUEST_TICK_MS = 500
/** A request the host never answered (it refused, or the track vanished) is given up after this long. */
const REQUEST_TIMEOUT_MS = 30_000
/** After a failed download, wait before asking for the same track again. */
const RETRY_AFTER_MS = 10_000
const COMMAND_GAP_MS = 150

/** Milliseconds on a clock that is the same kind on every device; only differences between devices are corrected. */
const clock = (): number => performance.timeOrigin + performance.now()

interface Peer {
  id: string
  link: PeerLink | null
  name: string
  status: PeerStatus
  rtt: number | null
  reason: string | null
  /** The other side's hello arrived: it speaks our protocol and holds the opposite role. */
  helloed: boolean
  /** Whether the other side allows us to control playback (a guest reads this from the host's hello). */
  remoteAllowsControl: boolean
  clocks: ClockSync
  pingTimer: ReturnType<typeof setTimeout> | null
  pings: number
  queue: Promise<void>
  serving: Set<string>
  sendAbort: AbortController | null
  nextTransfer: number
  lastCommandAt: number
  receiver: FileReceiver | null
}

let counter = 0

const toMeta = (t: Track): TrackMeta | null => {
  const size = t.file.size
  if (size < 1 || size > LIMITS.fileBytes) return null
  return {
    key: t.key,
    name: t.file.name.slice(0, LIMITS.fileNameChars),
    size,
    lastModified: t.file.lastModified,
    type: t.file.type,
    title: cleanText(t.title),
    artist: cleanText(t.artist),
    album: cleanText(t.album),
    duration: Number.isFinite(t.duration) ? Math.max(0, Math.min(86_400, t.duration)) : 0,
  }
}

export class ShareController {
  private readonly peers = new Map<string, Peer>()
  private timer: ReturnType<typeof setInterval> | null = null
  private seq = 0
  private lastAnnounce: Announcement | null = null
  /** Keys a guest may request: the track being played and the one after it. */
  private announced = new Set<string>()

  // guest state
  private hostState: StateMessage | null = null
  private lastSeq = -1
  private lastSeekAt = 0
  private lastToggleAt = 0
  private lastPlayAt = 0
  private inflight: { meta: TrackMeta; at: number } | null = null
  private failed = new Map<string, number>()
  /** Tracks received but still being read into the library (tags, cover): not missing, so not requested again. */
  private saving = new Set<string>()
  /** Host key -> the key the saved copy got here (a hostile or odd file name is cleaned on the way in). */
  private aliases = new Map<string, string>()
  private savedSpeed: number | null = null

  private get phase() {
    return getShareSnapshot().phase
  }

  // ---- public actions -------------------------------------------------------------------------------------------

  startHosting(): void {
    if (this.phase === 'host') return
    if (this.phase === 'guest') throw new Error('Leave the session you joined before hosting your own.')
    this.requireWebRtc()
    publishShare({ phase: 'host', error: null })
    this.startTimer(HOST_TICK_MS, () => this.tickHost())
  }

  async createInvite(): Promise<void> {
    this.startHosting()
    if (this.peers.size >= MAX_GUESTS) return void publishShare({ error: `You can have up to ${MAX_GUESTS} listeners at once.` })
    publishShare({ busy: true, error: null })
    const peer = this.addPeer()
    try {
      const { link, code } = await PeerLink.invite(this.eventsFor(peer))
      peer.link = link
      peer.status = 'inviting'
      publishShare({ invite: { peerId: peer.id, code }, busy: false })
    } catch (error) {
      this.peers.delete(peer.id)
      publishShare({ busy: false, error: this.describe(error) })
    }
    this.publishPeers()
  }

  async acceptReply(peerId: string, code: string): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer?.link || peer.status !== 'inviting') return void publishShare({ error: 'That invite is no longer waiting for a reply.' })
    publishShare({ busy: true, error: null })
    const result = await peer.link.acceptReply(code)
    if (!result.ok) return void publishShare({ busy: false, error: result.error })
    // on a fast network the other side's hello can arrive before this await returns
    if (peer.status === 'inviting') peer.status = 'connecting'
    publishShare({ busy: false, invite: null })
    this.publishPeers()
  }

  removePeer(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (!peer) return
    this.dropPeer(peer, true)
    if (getShareSnapshot().invite?.peerId === peerId) publishShare({ invite: null })
    this.publishPeers()
  }

  async join(code: string): Promise<void> {
    if (this.phase !== 'idle') return
    this.requireWebRtc()
    publishShare({ busy: true, error: null })
    const signal = await decodeSignal(code)
    if (!signal.ok) return void publishShare({ busy: false, error: signal.error })
    if (signal.kind !== 'offer') return void publishShare({ busy: false, error: 'That is a reply, not an invite. Paste the invite the host sent you.' })
    const peer = this.addPeer('host')
    peer.receiver = this.makeReceiver(peer)
    publishShare({ phase: 'guest' })
    try {
      const { link, code: reply } = await PeerLink.answer(signal.sdp, this.eventsFor(peer))
      peer.link = link
      publishShare({ reply, busy: false })
      this.startTimer(GUEST_TICK_MS, () => this.reconcile())
    } catch (error) {
      this.leave(this.describe(error))
    }
    this.publishPeers()
  }

  /** End the session (host: all listeners; guest: leave the host). */
  leave(error: string | null = null): void {
    for (const peer of [...this.peers.values()]) this.dropPeer(peer, true)
    this.peers.clear()
    this.stopTimer()
    this.hostState = null
    this.lastSeq = -1
    this.lastAnnounce = null
    this.announced.clear()
    this.inflight = null
    this.failed.clear()
    this.saving.clear()
    this.restoreSpeed()
    resetShare()
    if (error) publishShare({ error })
  }

  /** Guest: ask the host to play, pause, skip or seek (only when the host allows it). */
  command(cmd: RemoteCommand, value?: number): void {
    const peer = this.upstream()
    if (!peer?.helloed || !peer.remoteAllowsControl) return
    peer.link?.sendCtl(value === undefined ? { t: 'cmd', cmd } : { t: 'cmd', cmd, value })
  }

  /** Host: tell connected guests about a changed "guests can control" setting. */
  refreshHello(): void {
    for (const peer of this.peers.values()) if (peer.helloed) this.sendHello(peer)
  }

  // ---- peers ----------------------------------------------------------------------------------------------------

  private requireWebRtc(): void {
    if (!webRtcAvailable()) throw new Error('This device cannot make direct connections, so listening together is not available here.')
  }

  private addPeer(id = `guest-${++counter}`): Peer {
    const peer: Peer = {
      id,
      link: null,
      name: id === 'host' ? 'Host' : 'New listener',
      status: 'connecting',
      rtt: null,
      reason: null,
      helloed: false,
      remoteAllowsControl: false,
      clocks: new ClockSync(),
      pingTimer: null,
      pings: 0,
      queue: Promise.resolve(),
      serving: new Set(),
      sendAbort: null,
      nextTransfer: 0,
      lastCommandAt: 0,
      receiver: null,
    }
    this.peers.set(id, peer)
    return peer
  }

  private upstream(): Peer | undefined {
    return this.phase === 'guest' ? this.peers.get('host') : undefined
  }

  private eventsFor(peer: Peer) {
    return {
      onState: (state: string, reason?: string) => {
        if (state === 'open') this.onOpen(peer)
        else if (state === 'failed' || state === 'closed') this.onGone(peer, reason ?? 'The connection was closed.')
      },
      onCtl: (message: CtlMessage) => this.onCtl(peer, message),
      onFileFrame: (frame: Parameters<FileReceiver['handleFrame']>[0]) => {
        if (this.phase !== 'guest') return
        // a refusal carries no transfer id we know: match it by the track it names
        if (frame.t === 'abort' && this.inflight?.meta.key === frame.key && !peer.receiver?.current) this.failRequest(frame.key, frame.reason)
        else peer.receiver?.handleFrame(frame)
      },
      onBinary: (data: ArrayBuffer) => {
        if (this.phase === 'guest') peer.receiver?.handleBinary(data)
      },
    }
  }

  private onOpen(peer: Peer): void {
    this.sendHello(peer)
    this.ping(peer)
  }

  private onGone(peer: Peer, reason: string): void {
    if (!this.peers.has(peer.id) || peer.status === 'lost') return
    this.stopPings(peer)
    peer.sendAbort?.abort()
    peer.status = 'lost'
    peer.reason = reason
    if (this.phase === 'guest') return this.leave(peer.helloed ? `${peer.name} ended the session. ${reason}` : reason)
    if (getShareSnapshot().invite?.peerId === peer.id) publishShare({ invite: null })
    this.publishPeers()
  }

  private dropPeer(peer: Peer, notify: boolean): void {
    this.stopPings(peer)
    peer.sendAbort?.abort()
    peer.receiver?.cancel()
    if (notify && peer.helloed) peer.link?.sendCtl({ t: 'bye' })
    peer.status = 'lost'
    peer.link?.close()
    this.peers.delete(peer.id)
  }

  private publishPeers(): void {
    const views: PeerView[] = [...this.peers.values()]
      .filter((p) => p.id !== 'host')
      .map((p) => ({ id: p.id, name: p.name, status: p.status, rtt: p.rtt, reason: p.reason }))
    publishShare({ peers: views })
  }

  private sendHello(peer: Peer): void {
    const snap = getShareSnapshot()
    peer.link?.sendCtl({
      t: 'hello',
      v: PROTOCOL_VERSION,
      role: this.phase === 'host' ? 'host' : 'guest',
      name: snap.deviceName || (this.phase === 'host' ? 'Host' : 'Guest'),
      canControl: this.phase === 'host' && snap.allowControl,
    })
  }

  // ---- clock ----------------------------------------------------------------------------------------------------

  private ping(peer: Peer): void {
    if (!this.peers.has(peer.id) || !peer.link) return
    peer.link.sendCtl({ t: 'ping', id: peer.pings++, t0: clock() })
    // a quick burst first so the offset is usable within a couple of seconds, then a slow keep-alive
    peer.pingTimer = setTimeout(() => this.ping(peer), peer.pings < 8 ? 250 : 4000)
  }

  private stopPings(peer: Peer): void {
    if (peer.pingTimer) clearTimeout(peer.pingTimer)
    peer.pingTimer = null
  }

  // ---- messages -------------------------------------------------------------------------------------------------

  private onCtl(peer: Peer, msg: CtlMessage): void {
    if (!this.peers.has(peer.id)) return
    switch (msg.t) {
      case 'hello':
        return this.onHello(peer, msg)
      case 'ping':
        peer.link?.sendCtl({ t: 'pong', id: msg.id, t0: msg.t0, t1: clock(), t2: clock() })
        return
      case 'pong': {
        peer.clocks.add(sampleFrom(msg.t0, msg.t1, msg.t2, clock()))
        const estimate = peer.clocks.estimate()
        if (!estimate) return
        peer.rtt = Math.round(estimate.rtt)
        if (this.phase === 'guest') publishShare({ syncMs: Math.max(1, Math.round(estimate.rtt / 2)) })
        else this.publishPeers()
        return
      }
      case 'state':
        if (this.phase === 'guest' && peer.helloed && msg.seq > this.lastSeq) {
          this.lastSeq = msg.seq
          this.hostState = msg
          this.reconcile()
        }
        return
      case 'want':
        if (this.phase === 'host' && peer.helloed) this.serve(peer, msg.key)
        return
      case 'cmd':
        if (this.phase === 'host' && peer.helloed && getShareSnapshot().allowControl) this.runCommand(peer, msg)
        return
      case 'bye':
        if (this.phase === 'guest') this.leave(`${peer.name} ended the session.`)
        else this.removePeer(peer.id)
        return
    }
  }

  private onHello(peer: Peer, msg: Extract<CtlMessage, { t: 'hello' }>): void {
    const want = this.phase === 'host' ? 'guest' : 'host'
    if (msg.v !== PROTOCOL_VERSION) return this.refusePeer(peer, 'The other device runs a different version of Wavelocal. Update both and try again.')
    if (msg.role !== want) return this.refusePeer(peer, want === 'guest' ? 'The other device is also hosting. One of you must join instead.' : 'The other device joined as a listener too. One of you must host.')
    const first = !peer.helloed
    peer.helloed = true
    peer.name = msg.name
    peer.remoteAllowsControl = msg.canControl
    peer.status = 'connected'
    if (this.phase === 'guest') publishShare({ hostName: msg.name, hostAllowsControl: msg.canControl })
    else if (first) this.announce(peer)
    this.publishPeers()
  }

  private refusePeer(peer: Peer, reason: string): void {
    if (this.phase === 'guest') return this.leave(reason)
    peer.reason = reason
    this.dropPeer(peer, false)
    publishShare({ error: reason })
    this.publishPeers()
  }

  // ---- host -----------------------------------------------------------------------------------------------------

  private playback(): HostPlayback | null {
    const p = currentPlayer()
    if (!p) return null
    const position = p.position()
    return { key: p.current?.key ?? null, playing: p.playing, position: Number.isFinite(position) ? Math.max(0, Math.min(86_400, position)) : 0, speed: p.speed }
  }

  private nextTrack(): Track | null {
    const p = currentPlayer()
    if (!p?.current || p.shuffle || p.repeat === 'one') return null
    const at = p.queue.findIndex((t) => t.id === p.current?.id)
    const next = at >= 0 ? (p.queue[at + 1] ?? (p.repeat === 'all' ? p.queue[0] : undefined)) : undefined
    return next && next.id !== p.current.id ? next : null
  }

  private tickHost(): void {
    if (![...this.peers.values()].some((p) => p.helloed)) return
    const cur = this.playback()
    if (!cur) return
    if (broadcastReason(this.lastAnnounce, cur, clock())) this.announce()
  }

  /** Send the current state to everyone (or to one device that just joined). */
  private announce(only?: Peer): void {
    const p = currentPlayer()
    const cur = this.playback()
    if (!p || !cur) return
    const at = clock()
    const track = p.current ? toMeta(p.current) : null
    const nextTrack = this.nextTrack()
    const next = nextTrack ? toMeta(nextTrack) : null
    const message: CtlMessage = { t: 'state', seq: ++this.seq, track, next, playing: cur.playing, position: cur.position, speed: cur.speed, at }
    this.lastAnnounce = { ...cur, at }
    this.announced = new Set([track?.key, next?.key].filter((k): k is string => Boolean(k)))
    for (const peer of only ? [only] : this.peers.values()) if (peer.helloed) peer.link?.sendCtl(message)
  }

  private serve(peer: Peer, key: string): void {
    const refuse = (reason: string) => peer.link?.fileChannel?.send(encodeFileFrame({ t: 'abort', id: 0, key, reason }))
    const track = this.announced.has(key) ? currentPlayer()?.tracks.find((t) => t.key === key) : undefined
    const meta = track ? toMeta(track) : null
    if (!track || !meta) return void refuse('That track is not available.')
    if (peer.serving.has(key)) return
    peer.serving.add(key)
    // one transfer at a time per listener, in the order they were asked for
    peer.queue = peer.queue.then(() => this.sendTrack(peer, track.file, meta)).finally(() => peer.serving.delete(key))
  }

  private async sendTrack(peer: Peer, file: File, meta: TrackMeta): Promise<void> {
    const channel = peer.link?.fileChannel
    if (!channel) return
    const abort = (peer.sendAbort = new AbortController())
    try {
      await sendFile(channel, ++peer.nextTransfer, file, meta, { signal: abort.signal })
    } catch (error) {
      if (!(error instanceof TransferAborted)) {
        try {
          channel.send(encodeFileFrame({ t: 'abort', id: peer.nextTransfer, key: meta.key, reason: 'The host could not read that file.' }))
        } catch {
          /* channel gone */
        }
      }
    } finally {
      if (peer.sendAbort === abort) peer.sendAbort = null
    }
  }

  private runCommand(peer: Peer, msg: Extract<CtlMessage, { t: 'cmd' }>): void {
    const p = currentPlayer()
    const now = clock()
    if (!p || now - peer.lastCommandAt < COMMAND_GAP_MS) return
    peer.lastCommandAt = now
    if (msg.cmd === 'toggle') p.toggle()
    else if (msg.cmd === 'play') p.playing || p.toggle()
    else if (msg.cmd === 'pause') p.playing && p.toggle()
    else if (msg.cmd === 'next') p.next()
    else if (msg.cmd === 'prev') p.prev()
    else if (msg.cmd === 'seek' && msg.value !== undefined) p.seek(msg.value)
  }

  // ---- guest ----------------------------------------------------------------------------------------------------

  private makeReceiver(peer: Peer): FileReceiver {
    return new FileReceiver({
      wanted: (key) => this.inflight?.meta.key === key,
      onProgress: (meta, received) => publishShare({ transfer: { title: meta.title || meta.name, fraction: meta.size ? received / meta.size : 0 } }),
      onFile: (meta, blob) => {
        this.inflight = null
        publishShare({ transfer: null })
        const file = new File([blob], meta.name, { type: meta.type, lastModified: meta.lastModified })
        this.aliases.set(meta.key, fileKey(file))
        this.saving.add(meta.key)
        const saved = currentPlayer()?.addFiles([file]) ?? Promise.resolve(0)
        void saved
          .catch(() => 0)
          .then(() => {
            this.saving.delete(meta.key)
            // a file the library refused would otherwise be requested again on every tick
            if (!this.findLocal(meta)) this.failRequest(meta.key, 'it could not be added to your library')
            else this.reconcile()
          })
      },
      onFail: ({ key, reason }) => this.failRequest(key ?? this.inflight?.meta.key ?? null, reason),
    })
  }

  private failRequest(key: string | null, reason: string): void {
    if (key) this.failed.set(key, clock())
    this.inflight = null
    publishShare({ transfer: null, error: `Could not get the track: ${reason}` })
  }

  private findLocal(meta: TrackMeta): Track | undefined {
    const key = this.aliases.get(meta.key) ?? meta.key
    return currentPlayer()?.tracks.find((t) => t.key === key)
  }

  private request(meta: TrackMeta, peer: Peer): void {
    const now = clock()
    if (this.inflight) {
      // a request nobody answered must not block every later one
      if (now - this.inflight.at > REQUEST_TIMEOUT_MS && !peer.receiver?.current) this.failRequest(this.inflight.meta.key, 'the host did not respond')
      return
    }
    if (this.saving.has(meta.key)) return
    const failedAt = this.failed.get(meta.key)
    if (failedAt !== undefined && now - failedAt < RETRY_AFTER_MS) return
    if (!peer.link?.sendCtl({ t: 'want', key: meta.key })) return
    this.inflight = { meta, at: now }
    publishShare({ transfer: { title: meta.title || meta.name, fraction: 0 } })
  }

  /** Bring this device in line with the host's latest announcement. Safe to call as often as you like. */
  private reconcile(): void {
    const p = currentPlayer()
    const peer = this.upstream()
    const host = this.hostState
    if (!p || !peer?.helloed || !host) return
    const now = clock()
    publishShare({ nowPlaying: host.track ? { title: host.track.title || host.track.name, artist: host.track.artist } : null })

    if (!host.track) {
      if (p.playing && now - this.lastToggleAt >= 800) {
        this.lastToggleAt = now
        p.toggle()
      }
      return
    }
    const local = this.findLocal(host.track)
    if (!local) return this.request(host.track, peer)
    if (host.next && !this.findLocal(host.next)) this.request(host.next, peer)

    if (p.speed !== host.speed) {
      this.savedSpeed ??= p.speed
      p.setSpeed(host.speed)
    }
    if (p.currentId !== local.id) {
      if (now - this.lastPlayAt > 2000) {
        this.lastPlayAt = now
        p.play(local.id)
      }
      return
    }
    const action = planGuest(
      { playing: host.playing, position: host.position, speed: host.speed, at: host.at },
      peer.clocks.estimate()?.offset ?? 0,
      { ready: Number.isFinite(p.duration) && p.duration > 0, playing: p.playing, position: p.position() },
      { now, lastSeekAt: this.lastSeekAt, lastToggleAt: this.lastToggleAt },
      p.duration,
    )
    if (action.kind === 'toggle') {
      this.lastToggleAt = now
      p.toggle()
    } else if (action.kind === 'seek') {
      this.lastSeekAt = now
      p.seek(action.to)
    }
  }

  private restoreSpeed(): void {
    if (this.savedSpeed !== null) currentPlayer()?.setSpeed(this.savedSpeed)
    this.savedSpeed = null
  }

  // ---- timers ---------------------------------------------------------------------------------------------------

  private startTimer(ms: number, fn: () => void): void {
    this.stopTimer()
    this.timer = setInterval(fn, ms)
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private describe(error: unknown): string {
    return error instanceof Error && error.message ? error.message : 'Could not create the connection. Try again.'
  }
}
