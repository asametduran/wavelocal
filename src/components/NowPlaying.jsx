import { FolderOpen, Headphones, ListMusic, Upload } from 'lucide-react'
import Cover from './Cover'

export default function NowPlaying({ p, onPickFiles, onPickFolder, onToggleList }) {
  const { current, playing } = p

  return (
    <section className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-6 py-6">
      {current?.cover && (
        <img src={current.cover} alt="" className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover opacity-25 blur-3xl" />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-base/40 to-base" />

      <button
        onClick={onToggleList}
        className="absolute right-4 top-4 z-10 grid h-10 w-10 place-items-center rounded-full bg-white/5 text-zinc-300 hover:bg-white/10 md:hidden"
        aria-label="Toggle playlist"
      >
        <ListMusic size={20} />
      </button>

      {current ? (
        <div key={current.id} className="relative z-10 flex w-full max-w-md animate-fadeIn flex-col items-center text-center">
          <div className={`aspect-square w-full max-w-[min(100%,46vh)] overflow-hidden rounded-2xl shadow-2xl shadow-black/60 ring-1 ring-white/10 transition-transform duration-500 ${playing ? 'scale-100' : 'scale-95'}`}>
            <Cover track={current} className="h-full w-full" iconSize={72} />
          </div>
          <h1 className="mt-6 line-clamp-2 text-2xl font-bold tracking-tight sm:text-3xl">{current.title}</h1>
          <p className="mt-1 text-base text-zinc-300">{current.artist}</p>
          {current.album && <p className="text-sm text-zinc-500">{current.album}</p>}
        </div>
      ) : (
        <div className="relative z-10 flex max-w-md animate-fadeIn flex-col items-center text-center">
          <div className="grid h-28 w-28 place-items-center rounded-3xl bg-gradient-to-br from-accent/30 to-pink-500/20 ring-1 ring-white/10">
            <Headphones size={52} className="text-accent" strokeWidth={1.5} />
          </div>
          <h1 className="mt-6 text-3xl font-bold tracking-tight">Your music, your device.</h1>
          <p className="mt-2 text-zinc-400">
            Drop MP3s anywhere on this window. Files never leave your browser — no uploads, no accounts, no ads.
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
