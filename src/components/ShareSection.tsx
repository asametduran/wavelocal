import { useRef, useState } from 'react'
import { Check, Copy, Pause, Play, Radio, SkipBack, SkipForward, X } from 'lucide-react'
import { share, shareSupported, useShare } from '../lib/share/store'
import type { PeerView, ShareSnapshot } from '../lib/share/store'

const button = 'rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-zinc-200 transition hover:bg-white/15 disabled:opacity-40'
const primary = 'rounded-full bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition hover:opacity-90 disabled:opacity-40'
const field = 'w-full rounded-xl bg-white/5 p-3 font-mono text-xs text-zinc-200 outline-none ring-1 ring-white/10 focus:ring-accent'

/** A code the user copies to the other device. Falls back to selecting the text where the clipboard API is blocked. */
function CodeBox({ label, code }: { label: string; code: string }) {
  const area = useRef<HTMLTextAreaElement>(null)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      area.current?.select()
      document.execCommand?.('copy')
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-zinc-400">
        {label}
        <textarea ref={area} readOnly value={code} rows={3} onFocus={(e) => e.currentTarget.select()} className={`${field} mt-1 resize-none`} />
      </label>
      <button type="button" onClick={copy} className={`${button} mt-2 inline-flex items-center gap-2`}>
        {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy code'}
      </button>
    </div>
  )
}

function PasteBox({ label, action, onSubmit, busy }: { label: string; action: string; onSubmit: (code: string) => void; busy: boolean }) {
  const [code, setCode] = useState('')
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(code)
      }}
    >
      <label className="mb-1 block text-xs font-semibold text-zinc-400">
        {label}
        <textarea value={code} onChange={(e) => setCode(e.target.value)} rows={3} spellCheck={false} autoComplete="off" className={`${field} mt-1`} />
      </label>
      <button type="submit" disabled={busy || !code.trim()} className={`${primary} mt-2`}>
        {action}
      </button>
    </form>
  )
}

const STATUS: Record<PeerView['status'], string> = {
  inviting: 'Waiting for their reply',
  connecting: 'Connecting…',
  connected: 'Listening',
  lost: 'Disconnected',
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={`relative h-7 w-12 shrink-0 rounded-full transition ${on ? 'bg-accent' : 'bg-white/15'}`}>
      <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${on ? 'left-6' : 'left-1'}`} />
    </button>
  )
}

function Host({ s }: { s: ShareSnapshot }) {
  const invite = s.invite
  return (
    <div className="space-y-4">
      {s.peers.length > 0 && (
        <ul aria-label="Listeners" className="space-y-2">
          {s.peers.map((peer) => (
            <li key={peer.id} className="flex items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="block truncate font-semibold">{peer.name}</span>
                <span className="block text-xs text-zinc-400">
                  {peer.reason && peer.status === 'lost' ? peer.reason : STATUS[peer.status]}
                  {peer.status === 'connected' && peer.rtt !== null ? ` · ${peer.rtt} ms` : ''}
                </span>
              </span>
              <button type="button" onClick={() => void share.removePeer(peer.id)} aria-label={`${peer.status === 'inviting' ? 'Cancel invite for' : 'Remove'} ${peer.name}`} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-white">
                <X size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {invite ? (
        <div className="space-y-3 rounded-2xl bg-white/5 p-3">
          <p className="text-sm text-zinc-300">
            <strong>1.</strong> Send this invite to the other device (a message, a note, anything). <strong>2.</strong> Paste the reply they send back.
          </p>
          <CodeBox label="Invite code" code={invite.code} />
          <PasteBox label="Their reply code" action="Connect" busy={s.busy} onSubmit={(code) => void share.acceptReply(invite.peerId, code)} />
        </div>
      ) : (
        <button type="button" onClick={() => void share.createInvite()} disabled={s.busy} className={primary}>
          {s.busy ? 'Creating invite…' : s.peers.length ? 'Invite another listener' : 'Invite a listener'}
        </button>
      )}

      <div className="flex items-center justify-between gap-3 text-sm text-zinc-300">
        <span id="share-control-label">Let listeners play, pause and skip</span>
        <Switch on={s.allowControl} onChange={share.setAllowControl} label="Let listeners control playback" />
      </div>

      <button type="button" onClick={() => void share.leave()} className={button}>
        Stop hosting
      </button>
    </div>
  )
}

function Guest({ s }: { s: ShareSnapshot }) {
  const connected = s.hostName !== null
  return (
    <div className="space-y-4">
      {s.reply && !connected && (
        <div className="space-y-3 rounded-2xl bg-white/5 p-3">
          <p className="text-sm text-zinc-300">Send this reply back to the host and keep this window open. It connects as soon as they paste it.</p>
          <CodeBox label="Reply code" code={s.reply} />
        </div>
      )}
      {!s.reply && !connected && <p className="text-sm text-zinc-300">Creating your reply…</p>}

      {connected && (
        <div className="space-y-3" role="status" aria-live="polite">
          <p className="text-sm">
            Listening with <strong>{s.hostName}</strong>
            {s.syncMs !== null && <span className="text-zinc-400"> · in sync within about {s.syncMs} ms</span>}
          </p>
          {s.nowPlaying ? (
            <p className="text-sm text-zinc-300">
              Playing <strong>{s.nowPlaying.title}</strong>
              {s.nowPlaying.artist ? ` by ${s.nowPlaying.artist}` : ''}
            </p>
          ) : (
            <p className="text-sm text-zinc-400">Waiting for the host to play something.</p>
          )}
          {s.transfer && (
            <div>
              <p className="mb-1 text-xs text-zinc-400">Receiving “{s.transfer.title}” from the host · saved to your library</p>
              <div role="progressbar" aria-label="Receiving track" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s.transfer.fraction * 100)} className="h-2 overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(s.transfer.fraction * 100)}%` }} />
              </div>
            </div>
          )}
          {s.hostAllowsControl && (
            <div className="flex items-center gap-2" role="group" aria-label="Control the host's playback">
              <button type="button" onClick={() => void share.command('prev')} aria-label="Previous track" className={`${button} !px-3`}>
                <SkipBack size={16} />
              </button>
              <button type="button" onClick={() => void share.command('toggle')} aria-label="Play or pause" className={`${button} !px-3`}>
                <Play size={16} /> <span className="sr-only">/</span> <Pause size={16} />
              </button>
              <button type="button" onClick={() => void share.command('next')} aria-label="Next track" className={`${button} !px-3`}>
                <SkipForward size={16} />
              </button>
            </div>
          )}
        </div>
      )}

      <button type="button" onClick={() => void share.leave()} className={button}>
        {connected ? 'Leave session' : 'Cancel'}
      </button>
    </div>
  )
}

/**
 * Listen together over the local network: one device hosts, others join and hear the same track in sync. Pairing is
 * a copy-and-paste exchange of two codes; there is no server and nothing leaves the local network.
 */
export default function ShareSection() {
  const s = useShare()
  const [name, setName] = useState(s.deviceName)
  const supported = shareSupported()

  return (
    <section aria-label="Listen together" className="mt-6">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
        <Radio size={15} /> Listen together
      </h3>

      {s.error && (
        <div role="alert" className="mb-3 flex items-start justify-between gap-3 rounded-xl bg-red-500/15 px-3 py-2 text-sm text-red-200">
          <span>{s.error}</span>
          <button type="button" onClick={share.dismissError} aria-label="Dismiss message" className="shrink-0 text-red-200 hover:text-white">
            <X size={16} />
          </button>
        </div>
      )}

      {!supported ? (
        <p className="text-sm text-zinc-400">This device cannot make direct connections, so listening together is not available here.</p>
      ) : s.phase === 'host' ? (
        <Host s={s} />
      ) : s.phase === 'guest' ? (
        <Guest s={s} />
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-zinc-400">
            Play your music on several devices at once, in sync, on the same Wi-Fi. Connections go straight between the devices — no server, no account, nothing leaves your network.
          </p>
          <label className="block text-xs font-semibold text-zinc-400">
            This device is called
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                share.setDeviceName(e.target.value)
              }}
              maxLength={40}
              className="mt-1 w-full rounded-xl bg-white/5 px-3 py-2 text-sm font-normal text-zinc-100 outline-none ring-1 ring-white/10 focus:ring-accent"
            />
          </label>
          <div>
            <button type="button" onClick={() => void share.createInvite()} disabled={s.busy} className={primary}>
              {s.busy ? 'Creating invite…' : 'Host a session'}
            </button>
            <p className="mt-2 text-xs text-zinc-400">Others hear what you play. Songs they do not have are sent to them for this session and saved in their library.</p>
          </div>
          <PasteBox label="Or join a session: paste the host’s invite code" action={s.busy ? 'Joining…' : 'Join'} busy={s.busy} onSubmit={(code) => void share.join(code)} />
        </div>
      )}
    </section>
  )
}
