/**
 * One WebRTC connection to one other Wavelocal device.
 *
 * Privacy by construction: the connection is created with NO ICE servers, so no STUN or TURN request ever leaves the
 * local network and no third party learns that two devices are talking. Only host candidates (the devices' own LAN
 * addresses) are offered, which is also why this works on a shared Wi-Fi but not across the internet. There is no
 * signalling server either: the offer and answer are complete (gathering is awaited, nothing trickles) and travel as
 * the pairing codes of `signal.ts`.
 */
import { CTL_LABEL, FILE_LABEL, encodeCtl, parseCtl, parseFileFrame } from './protocol'
import type { CtlMessage, FileFrame } from './protocol'
import { decodeSignal, encodeSignal } from './signal'
import type { SignalKind } from './signal'
import type { SendChannel } from './transfer'

export type LinkState = 'connecting' | 'open' | 'closed' | 'failed'

export interface LinkEvents {
  onState(state: LinkState, reason?: string): void
  onCtl(message: CtlMessage): void
  onFileFrame(frame: FileFrame): void
  onBinary(data: ArrayBuffer): void
}

/** How long to wait for the local network addresses to be collected. They are found within a fraction of a second. */
const GATHER_TIMEOUT_MS = 6000
/** How long the two devices get to find each other once both codes have been exchanged. */
const CONNECT_TIMEOUT_MS = 45_000
/** A brief network blip should not end a session; a lasting one should. */
const DISCONNECT_GRACE_MS = 8000

export const webRtcAvailable = (): boolean => typeof RTCPeerConnection === 'function'

export type CodeResult = { ok: true; code: string } | { ok: false; error: string }

export class PeerLink {
  private readonly pc: RTCPeerConnection
  private ctl: RTCDataChannel | null = null
  private file: RTCDataChannel | null = null
  private state: LinkState = 'connecting'
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private graceTimer: ReturnType<typeof setTimeout> | null = null

  private constructor(private readonly events: LinkEvents) {
    this.pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' })
    this.pc.addEventListener('connectionstatechange', () => this.onConnectionState())
    this.pc.addEventListener('datachannel', (e) => this.adopt(e.channel))
  }

  /** Start a connection from this side: returns the link and the invite code to hand to the other device. */
  static async invite(events: LinkEvents): Promise<{ link: PeerLink; code: string }> {
    const link = new PeerLink(events)
    try {
      link.adopt(link.pc.createDataChannel(CTL_LABEL, { ordered: true }))
      link.adopt(link.pc.createDataChannel(FILE_LABEL, { ordered: true }))
      await link.pc.setLocalDescription(await link.pc.createOffer())
      return { link, code: await encodeSignal('offer', await link.gathered()) }
    } catch (error) {
      link.close()
      throw error
    }
  }

  /** Answer an invite from the other device: returns the link and the reply code to send back. */
  static async answer(offerSdp: string, events: LinkEvents): Promise<{ link: PeerLink; code: string }> {
    const link = new PeerLink(events)
    try {
      await link.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
      await link.pc.setLocalDescription(await link.pc.createAnswer())
      const code = await encodeSignal('answer', await link.gathered())
      link.expectConnection()
      return { link, code }
    } catch (error) {
      link.close()
      throw error
    }
  }

  /** The inviting side finishes the handshake with the reply code. */
  async acceptReply(code: string): Promise<CodeResult> {
    const signal = await decodeSignal(code)
    if (!signal.ok) return signal
    return this.acceptSdp(signal.kind, signal.sdp)
  }

  async acceptSdp(kind: SignalKind, sdp: string): Promise<CodeResult> {
    if (kind !== 'answer') return { ok: false, error: 'That is an invite, not a reply. Paste the reply the other device created.' }
    if (this.pc.signalingState !== 'have-local-offer') return { ok: false, error: 'This invite was already used. Create a new one.' }
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp })
    } catch {
      return { ok: false, error: 'That reply does not belong to this invite. Check that you pasted the right one.' }
    }
    this.expectConnection()
    return { ok: true, code: '' }
  }

  get linkState(): LinkState {
    return this.state
  }

  /** The send side of the file channel, once it is open. */
  get fileChannel(): SendChannel | null {
    return this.file?.readyState === 'open' ? (this.file as unknown as SendChannel) : null
  }

  sendCtl(message: CtlMessage): boolean {
    if (this.ctl?.readyState !== 'open') return false
    try {
      this.ctl.send(encodeCtl(message))
      return true
    } catch {
      return false
    }
  }

  close(): void {
    this.clearTimers()
    if (this.state !== 'failed') this.setState('closed')
    for (const channel of [this.ctl, this.file]) {
      if (channel) {
        channel.onmessage = null
        channel.onclose = null
        try {
          channel.close()
        } catch {
          /* already closed */
        }
      }
    }
    try {
      this.pc.close()
    } catch {
      /* already closed */
    }
  }

  private gathered(): Promise<string> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        this.pc.removeEventListener('icegatheringstatechange', check)
        clearTimeout(timer)
        const sdp = this.pc.localDescription?.sdp ?? ''
        if (/\na=candidate:/.test(sdp)) resolve(sdp)
        else reject(new Error('No local network address was found. Connect to Wi-Fi or a network first.'))
      }
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') finish()
      }
      const timer = setTimeout(finish, GATHER_TIMEOUT_MS)
      this.pc.addEventListener('icegatheringstatechange', check)
      check()
    })
  }

  private expectConnection(): void {
    this.clearTimers()
    this.connectTimer = setTimeout(() => {
      if (this.state === 'connecting') this.fail('Could not reach the other device. Both must be on the same network.')
    }, CONNECT_TIMEOUT_MS)
  }

  private adopt(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer'
    if (channel.label === CTL_LABEL) {
      this.ctl = channel
      channel.onmessage = (e) => {
        const message = parseCtl(e.data)
        if (message) this.events.onCtl(message)
      }
    } else if (channel.label === FILE_LABEL) {
      this.file = channel
      channel.onmessage = (e) => {
        if (typeof e.data === 'string') {
          const frame = parseFileFrame(e.data)
          if (frame) this.events.onFileFrame(frame)
        } else if (e.data instanceof ArrayBuffer) this.events.onBinary(e.data)
      }
    } else {
      // a channel this version does not know: refuse it rather than let the peer open arbitrary streams
      channel.close()
      return
    }
    channel.onopen = () => this.checkOpen()
    channel.onclose = () => this.fail('The connection was closed.')
    this.checkOpen()
  }

  private checkOpen(): void {
    if (this.state === 'connecting' && this.ctl?.readyState === 'open' && this.file?.readyState === 'open') {
      this.clearTimers()
      this.setState('open')
    }
  }

  private onConnectionState(): void {
    const s = this.pc.connectionState
    if (s === 'failed') return this.fail('The connection failed. Both devices must be on the same network.')
    if (s === 'closed') return this.fail('The connection was closed.')
    if (s === 'disconnected') {
      this.graceTimer ??= setTimeout(() => this.fail('The connection was lost.'), DISCONNECT_GRACE_MS)
    } else if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
  }

  private fail(reason: string): void {
    if (this.state === 'closed' || this.state === 'failed') return
    this.clearTimers()
    this.setState('failed', reason)
  }

  private setState(state: LinkState, reason?: string): void {
    if (this.state === state) return
    this.state = state
    this.events.onState(state, reason)
  }

  private clearTimers(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.connectTimer = this.graceTimer = null
  }
}
