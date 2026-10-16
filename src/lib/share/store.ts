/**
 * The small, always-loaded face of "listen together". The WebRTC machinery (peer, protocol, transfer, controller) is a
 * separate chunk that is only downloaded the first time someone starts or joins a session; until then this module is
 * all the app carries: a snapshot the Share panel renders and thin actions that load the controller on demand.
 */
import { useSyncExternalStore } from 'react'
import type { PlayerApi } from '../../types'
import type { RemoteCommand } from './protocol'

export type PeerStatus = 'inviting' | 'connecting' | 'connected' | 'lost'

/** One other device as the panel shows it. */
export interface PeerView {
  id: string
  name: string
  status: PeerStatus
  /** Round trip in milliseconds, once measured. */
  rtt: number | null
  reason: string | null
}

export type SharePhase = 'idle' | 'host' | 'guest'

export interface ShareSnapshot {
  phase: SharePhase
  deviceName: string
  /** Host option: let guests play, pause and skip. */
  allowControl: boolean
  peers: PeerView[]
  /** Host: the invite code waiting for a reply, and which device slot it belongs to. */
  invite: { peerId: string; code: string } | null
  /** Guest: the reply code to send back to the host. */
  reply: string | null
  /** Something is being created or connected right now. */
  busy: boolean
  /** The last problem, in words a person can act on. */
  error: string | null
  /** Guest: what the host is playing, whether the host lets us control it, and how a download is going. */
  hostName: string | null
  hostAllowsControl: boolean
  nowPlaying: { title: string; artist: string } | null
  transfer: { title: string; fraction: number } | null
  /** Guest: how well the clocks agree (milliseconds of uncertainty), once measured. */
  syncMs: number | null
}

const NAME_KEY = 'wl-share-name'
const DEFAULT_NAME = 'My device'

function loadName(): string {
  try {
    return (localStorage.getItem(NAME_KEY) || '').slice(0, 40) || DEFAULT_NAME
  } catch {
    return DEFAULT_NAME
  }
}

const initial = (): ShareSnapshot => ({
  phase: 'idle',
  deviceName: loadName(),
  allowControl: false,
  peers: [],
  invite: null,
  reply: null,
  busy: false,
  error: null,
  hostName: null,
  hostAllowsControl: false,
  nowPlaying: null,
  transfer: null,
  syncMs: null,
})

let snapshot: ShareSnapshot = initial()
const listeners = new Set<() => void>()

export const getShareSnapshot = (): ShareSnapshot => snapshot
export const subscribeShare = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Replace parts of the snapshot (used by the controller). Always produces a new object so React re-renders. */
export function publishShare(patch: Partial<ShareSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const listener of [...listeners]) listener()
}

export const resetShare = (): void => publishShare({ ...initial(), deviceName: snapshot.deviceName, allowControl: snapshot.allowControl })

/** The latest player, kept current by the App so the controller can read it without any React plumbing. */
let player: PlayerApi | null = null
export const attachPlayer = (p: PlayerApi): void => {
  player = p
}
export const currentPlayer = (): PlayerApi | null => player

export function useShare(): ShareSnapshot {
  return useSyncExternalStore(subscribeShare, getShareSnapshot, getShareSnapshot)
}

/** Whether this device can do WebRTC at all (it can in every browser and WebView this app supports). */
export const shareSupported = (): boolean => typeof RTCPeerConnection === 'function' && typeof RTCDataChannel === 'function'

type Controller = InstanceType<typeof import('./controller').ShareController>
let loaded: Promise<Controller> | null = null

function controller(): Promise<Controller> {
  loaded ??= import('./controller').then((m) => new m.ShareController())
  return loaded
}

/** Run `action` on the controller; a failed download of the chunk (offline before first use) becomes a readable error. */
async function run(action: (c: Controller) => Promise<void> | void): Promise<void> {
  try {
    await action(await controller())
  } catch (error) {
    loaded = null
    publishShare({ busy: false, error: error instanceof Error && error.message ? error.message : 'Could not start sharing. Try again.' })
  }
}

export const share = {
  setDeviceName(name: string): void {
    const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40)
    publishShare({ deviceName: clean })
    try {
      localStorage.setItem(NAME_KEY, clean)
    } catch {
      /* not remembered */
    }
  },
  setAllowControl: (allow: boolean): void => {
    publishShare({ allowControl: allow })
    if (snapshot.phase === 'host') void run((c) => c.refreshHello())
  },
  dismissError: (): void => publishShare({ error: null }),
  startHosting: (): Promise<void> => run((c) => c.startHosting()),
  createInvite: (): Promise<void> => run((c) => c.createInvite()),
  acceptReply: (peerId: string, code: string): Promise<void> => run((c) => c.acceptReply(peerId, code)),
  removePeer: (peerId: string): Promise<void> => run((c) => c.removePeer(peerId)),
  join: (code: string): Promise<void> => run((c) => c.join(code)),
  leave: (): Promise<void> => (loaded ? run((c) => c.leave()) : Promise.resolve()),
  command: (cmd: RemoteCommand, value?: number): Promise<void> => run((c) => c.command(cmd, value)),
}
