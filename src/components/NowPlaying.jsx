import { useState } from 'react'
import { FolderOpen, Headphones, Upload } from 'lucide-react'
import Cover from './Cover'
import Lyrics from './Lyrics'
import Visualizer from './Visualizer'

export function StageTabs({ tab, setTab, hasLyrics }) {
  const btn = (id, label) => (
    <button
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={`relative rounded-full px-4 py-1.5 text-sm font-semibold transition ${tab === id ? 'bg-white text-black' : 'text-zinc-300 hover:bg-white/10'}`}
    >
      {label}
      {id === 'lyrics' && hasLyrics && tab !== id && <span className="absolute right-1.5 top-1 h-1.5 w-1.5 rounded-full bg-accent" />}
    </button>
  )
  return (
    <div role="tablist" className="flex gap-1 rounded-full bg-white/5 p-1">
      {btn('art', 'Artwork')}
      {btn('lyrics', 'Lyrics')}
    </div>
  )
}

export default function NowPlaying({ p, onPickFiles, onPickFolder }) {
  const { current, playing } = p
  const [tab, setTab] = useState('art')

  return (
    <section className="relative hidden min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-6 py-6 md:flex">
      {current?.cover && (
        <img src={current.cover} alt="" className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover opacity-25 blur-3xl" />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-base/40 to-base" />

      {current ? (
        <div className="relative z-10 flex h-full min-h-0 w-full max-w-lg flex-col items-center gap-4">
          <StageTabs tab={tab} setTab={setTab} hasLyrics={!!current.lyrics} />

          {tab === 'art' ? (
            <div key={current.id} className="flex min-h-0 w-full flex-1 animate-fadeIn flex-col items-center justify-center text-center">
              <div className={`aspect-square w-full max-w-[min(100%,38vh)] overflow-hidden rounded-2xl shadow-2xl shadow-black/60 ring-1 ring-white/10 transition-transform duration-500 ${playing ? 'scale-100' : 'scale-95'}`}>
                <Cover track={current} className="h-full w-full" iconSize={72} />
              </div>
              <h1 className="mt-5 line-clamp-2 text-2xl font-bold tracking-tight sm:text-3xl">{current.title}</h1>
              <p className="mt-1 text-base text-zinc-300">{current.artist}</p>
              {current.album && <p className="text-sm text-zinc-500">{current.album}</p>}
              <Visualizer engine={p.engine} playing={playing} className="mt-5 h-16 max-w-md" />
            </div>
          ) : (
            <div className="flex min-h-0 w-full flex-1 flex-col">
              <div className="mb-2 text-center">
                <div className="truncate text-sm font-semibold">{current.title}</div>
                <div className="truncate text-xs text-zinc-400">{current.artist}</div>
              </div>
              <Lyrics track={current} time={p.time} onSeek={p.seek} onLoad={p.attachLrc} className="min-h-0 flex-1" />
            </div>
          )}
        </div>
      ) : (
        <div className="relative z-10 flex max-w-md animate-fadeIn flex-col items-center text-center">
          <div className="grid h-28 w-28 place-items-center rounded-3xl bg-gradient-to-br from-accent/30 to-pink-500/20 ring-1 ring-white/10">
            <Headphones size={52} className="text-accent" strokeWidth={1.5} />
          </div>
          <h1 className="mt-6 text-3xl font-bold tracking-tight">Your music, your device.</h1>
          <p className="mt-2 text-zinc-400">
            Drop MP3s (and .lrc lyrics) anywhere on this window. Files stay on your device and are remembered next time — no uploads, no accounts, no ads.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <button onClick={onPickFiles} className="flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black transition hover:scale-105">
              <Upload size={16} /> Add files
            </button>
            <button onClick={onPickFolder} className="flex items-center gap-2 rounded-full bg-white/10 px-5 py-2.5 text-sm font-semibold transition hover:bg-white/15">
              <FolderOpen size={16} /> Add folder
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
