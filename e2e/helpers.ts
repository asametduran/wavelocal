import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { buildFixture, buildFlac, lrcText } from '../src/test-utils/fixtures'
import { buildMp3 } from '../src/test-utils/containers'
import { buildId3v2, withId3 } from '../src/test-utils/id3'
import type { Id3Fields } from '../src/test-utils/id3'
import { sine } from '../src/test-utils/signals'
import { encodeWav } from '../src/test-utils/wav'
import type { FixtureName } from '../src/test-utils/fixtures'
import type { FlacEncodeOptions } from '../src/test-utils/flac-encoder'
import { realMp3, realOgg } from './realAudio'

export interface Upload {
  name: string
  mimeType: string
  buffer: Buffer
}

/** A track as the app has saved it in its own database. */
export interface StoredTrack {
  id: string
  name: string
  title: string
  /** True when lyrics were saved with the track. */
  lyrics: boolean
}

/** A synthetic WAV fixture as an uploadable file. */
export const wav = (fixture: FixtureName, name = `${fixture}.wav`): Upload => ({
  name,
  mimeType: 'audio/wav',
  buffer: Buffer.from(buildFixture(fixture).bytes),
})

/** A synthetic fixture encoded as FLAC. */
export const flac = (fixture: FixtureName, name = `${fixture}.flac`, options: Partial<FlacEncodeOptions> = {}): Upload => ({
  name,
  mimeType: 'audio/flac',
  buffer: Buffer.from(buildFlac(fixture, options)),
})

/** A sidecar lyrics file built from [seconds, text] pairs. */
export const lrc = (name: string, lines: readonly (readonly [seconds: number, text: string])[]): Upload => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from(lrcText(lines)),
})

/**
 * Import files whose modified time is fixed, so that two devices (or two sessions) end up with the same library key
 * (`name|size|modified`). `setInputFiles` stamps the current time, which would make every import a different file.
 */
export async function importWithMtime(app: { page: Page }, files: readonly Upload[], lastModified: number): Promise<void> {
  await app.page.evaluate(
    async ({ items, lastModified }) => {
      const transfer = new DataTransfer()
      for (const { name, type, base64 } of items) {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
        transfer.items.add(new File([bytes], name, { type, lastModified }))
      }
      const input = document.querySelector<HTMLInputElement>('input[type=file]')
      if (!input) throw new Error('no file input')
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { items: files.map((f) => ({ name: f.name, type: f.mimeType, base64: f.buffer.toString('base64') })), lastModified },
  )
}

/** The library key the app gives an uploaded file (see `fileKey` in src/lib/metadata.ts). */
export const libraryKey = (file: Upload, lastModified: number): string => `${file.name}|${file.buffer.length}|${lastModified}`

/**
 * A short MP3 with an ID3 tag: how tests give a library artists, albums, track numbers and years. `frames` of 1152
 * samples each at 44.1 kHz make it about 26 ms per frame, so the default plays for roughly a second and a half.
 */
export const song = (name: string, tags: Id3Fields, frames = 60): Upload => ({
  name,
  mimeType: 'audio/mpeg',
  buffer: Buffer.from(withId3(buildId3v2(tags), buildMp3({ frames }))),
})

/** A real, decodable MP3 and Ogg Vorbis (a 1 kHz tone: 1.5 s loud, 1 s silent, 1.5 s quiet; see realAudio.ts). */
export const realMp3File = (name: string): Upload => ({ name, mimeType: 'audio/mpeg', buffer: realMp3() })
export const realOggFile = (name: string): Upload => ({ name, mimeType: 'audio/ogg', buffer: realOgg() })

/** A very short tone, for tests that need many cheap tracks. */
export const tone = (name: string, seconds = 0.1, frequency = 440): Upload => ({
  name,
  mimeType: 'audio/wav',
  buffer: Buffer.from(encodeWav([sine({ frequency, amplitude: 0.4, seconds })])),
})

/**
 * Everything the page created that tests may want to inspect: playing media elements, EQ filters and gain nodes.
 * Gain order follows AudioEngine.init(): [master, eq.in, eq.bypass, eq.through, eq.out, deck0.norm, deck0.crossfade,
 * deck1.norm, deck1.crossfade, comp.makeup, comp.bypass, comp.through, matrix.ll, .lr, .rl, .rr, spatial.dry, spatial.wet,
 * spatial.out, reverb.dry, reverb.wet, reverb.out, limiter.bypass, limiter.through].
 */
export interface AudioProbe {
  media: Set<HTMLMediaElement>
  filters: BiquadFilterNode[]
  gains: GainNode[]
  panners: PannerNode[]
  convolvers: ConvolverNode[]
  delays: DelayNode[]
  /** Audio-node connections as the page made them (outgoing edges), so tests can walk the real signal path. */
  edges: Map<AudioNode, Set<AudioNode>>
  /** Dynamics compressors in creation order: [compressor, limiter]. */
  compressors: DynamicsCompressorNode[]
  /** Analysers on the left and right channel of the very last node before the speakers. */
  taps: { left: AnalyserNode; right: AnalyserNode } | null
  /** Every object URL the page created, with the type and size of its Blob. */
  blobs: Map<string, { type: string; size: number }>
  revoked: string[]
  /** How many Web Workers the page started. */
  workers: number
}

/** A request or script the page's Content-Security-Policy blocked, as the browser reported it. */
export interface PolicyViolation {
  directive: string
  blocked: string
  sample: string
}

declare global {
  interface Window {
    __probe: AudioProbe
    __csp: PolicyViolation[]
  }
}

/**
 * Wait until every CSS animation and transition on the page has ended. A dialog fades in and a chip changes colour over a
 * fraction of a second, and an accessibility scan reads the colours of whatever frame it catches: half way through a fade the
 * contrast is too low, and a runner slower than a laptop gets caught by it. (Endless animations, such as a spinner, are not
 * waited for.) Looks again afterwards, since the end of one transition can start another.
 */
export async function settled(page: Page): Promise<void> {
  for (let round = 0; round < 5; round++) {
    const waited = await page.evaluate(async () => {
      const running = document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? 0))
      await Promise.all(running.map((animation) => animation.finished.then(() => undefined, () => undefined)))
      return running.length
    })
    if (waited === 0) return
  }
}

/** Record every Content-Security-Policy violation of the page (must run before the page loads). */
export async function installPolicyWatch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__csp = []
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__csp.push({ directive: event.effectiveDirective, blocked: event.blockedURI, sample: event.sample })
    })
  })
}

export const GAIN = {
  master: 0,
  eqIn: 1,
  eqBypass: 2,
  eqThrough: 3,
  eqOut: 4,
  deck0Norm: 5,
  deck0Fade: 6,
  deck1Norm: 7,
  deck1Fade: 8,
  compMakeup: 9,
  compBypass: 10,
  compThrough: 11,
  matrixLL: 12,
  matrixLR: 13,
  matrixRL: 14,
  matrixRR: 15,
  spatialDry: 16,
  spatialWet: 17,
  spatialOut: 18,
  reverbDry: 19,
  reverbWet: 20,
  reverbOut: 21,
  limiterBypass: 22,
  limiterThrough: 23,
} as const

/** The bass and treble shelves are created before the equalizer bands, so band filters start at this probe index. */
const TONE_FILTERS = 2

/** Record media elements and audio nodes created by the app (must run before the page loads). */
export async function installAudioProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: AudioProbe = { media: new Set(), filters: [], gains: [], panners: [], convolvers: [], delays: [], edges: new Map(), compressors: [], taps: null, blobs: new Map(), revoked: [], workers: 0 }
    window.__probe = probe
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      probe.media.add(this)
      return play.call(this)
    }
    const biquad = AudioContext.prototype.createBiquadFilter
    AudioContext.prototype.createBiquadFilter = function (this: AudioContext) {
      const node = biquad.call(this)
      probe.filters.push(node)
      return node
    }
    const createObjectURL = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (source: Blob | MediaSource) => {
      const url = createObjectURL(source)
      if (source instanceof Blob) probe.blobs.set(url, { type: source.type, size: source.size })
      return url
    }
    const revokeObjectURL = URL.revokeObjectURL.bind(URL)
    URL.revokeObjectURL = (url: string) => {
      probe.revoked.push(url)
      revokeObjectURL(url)
    }
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        probe.workers++
      }
    }

    type ConnectFn = (this: AudioNode, destination: AudioNode | AudioParam, output?: number, input?: number) => unknown
    type DisconnectFn = (this: AudioNode, destination?: AudioNode | AudioParam | number) => void
    const connect = AudioNode.prototype.connect as unknown as ConnectFn
    const disconnect = AudioNode.prototype.disconnect as unknown as DisconnectFn
    AudioNode.prototype.connect = function (this: AudioNode, destination: AudioNode | AudioParam, output?: number, input?: number) {
      if (destination instanceof AudioNode) {
        const out = probe.edges.get(this) ?? new Set<AudioNode>()
        out.add(destination)
        probe.edges.set(this, out)
      }
      const result = connect.call(this, destination, output, input)
      if (destination instanceof AudioDestinationNode && !probe.taps) {
        // listen to what really reaches the speakers: one analyser per channel
        const ctx = destination.context
        const splitter = ctx.createChannelSplitter(2)
        const left = ctx.createAnalyser()
        const right = ctx.createAnalyser()
        left.fftSize = 4096
        right.fftSize = 4096
        connect.call(this, splitter)
        connect.call(splitter, left, 0)
        connect.call(splitter, right, 1)
        probe.taps = { left, right }
      }
      return result
    } as typeof AudioNode.prototype.connect
    AudioNode.prototype.disconnect = function (this: AudioNode, destination?: AudioNode | AudioParam | number) {
      if (destination === undefined || typeof destination === 'number') probe.edges.delete(this)
      else if (destination instanceof AudioNode) probe.edges.get(this)?.delete(destination)
      return disconnect.call(this, destination)
    } as typeof AudioNode.prototype.disconnect
    const panner = AudioContext.prototype.createPanner
    AudioContext.prototype.createPanner = function (this: AudioContext) {
      const node = panner.call(this)
      probe.panners.push(node)
      return node
    }
    const compressor = AudioContext.prototype.createDynamicsCompressor
    AudioContext.prototype.createDynamicsCompressor = function (this: AudioContext) {
      const node = compressor.call(this)
      probe.compressors.push(node)
      return node
    }
    const convolver = AudioContext.prototype.createConvolver
    AudioContext.prototype.createConvolver = function (this: AudioContext) {
      const node = convolver.call(this)
      probe.convolvers.push(node)
      return node
    }
    const delay = AudioContext.prototype.createDelay
    AudioContext.prototype.createDelay = function (this: AudioContext, max?: number) {
      const node = delay.call(this, max)
      probe.delays.push(node)
      return node
    }
    const gain = AudioContext.prototype.createGain
    AudioContext.prototype.createGain = function (this: AudioContext) {
      const node = gain.call(this)
      probe.gains.push(node)
      return node
    }
  })
}

/** Make the browser claim it cannot play WAV or FLAC at all, the way some old WebViews do. Install before `open()`. */
export async function denyNativeLossless(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const canPlayType = HTMLMediaElement.prototype.canPlayType
    HTMLMediaElement.prototype.canPlayType = function (this: HTMLMediaElement, type: string) {
      return /^audio\/(x-)?(wav|wave|flac)/i.test(type) ? '' : canPlayType.call(this, type)
    }
  })
}

/**
 * Make a media element that has been given an original FLAC file fail the way an unsupported format does:
 * play() is rejected and an `error` event follows, while canPlayType still claims support. Install before `open()`.
 */
export async function failNativeFlacPlayback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const types = new Map<string, string>()
    const create = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (source: Blob | MediaSource) => {
      const url = create(source)
      if (source instanceof Blob) types.set(url, source.type)
      return url
    }
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (types.get(this.getAttribute('src') ?? '') === 'audio/flac') {
        setTimeout(() => this.dispatchEvent(new Event('error')), 0)
        return Promise.reject(new DOMException('The element has no supported sources.', 'NotSupportedError'))
      }
      return play.call(this)
    }
  })
}

/**
 * Make the decoder worker slow: every conversion after the first `skip` starts `ms` late, so a track that was lined up to
 * play next is not ready when its turn comes (a big FLAC on a slow phone). Install before `open()`.
 */
export async function slowDecoding(page: Page, ms: number, skip = 1): Promise<void> {
  await page.addInitScript(
    ({ ms, skip }) => {
      const post = Worker.prototype.postMessage as (this: Worker, message: unknown, ...rest: unknown[]) => void
      let conversions = 0
      Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
        if ((message as { type?: string } | null)?.type === 'convert' && ++conversions > skip) {
          setTimeout(() => post.call(this, message, ...rest), ms)
          return
        }
        post.call(this, message, ...rest)
      } as typeof Worker.prototype.postMessage
    },
    { ms, skip },
  )
}

/** Make decodeAudioData reject FLAC data (as a browser without FLAC support would). Install before `open()`. */
export async function rejectFlacDecoding(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const decode = BaseAudioContext.prototype.decodeAudioData as (this: BaseAudioContext, data: ArrayBuffer) => Promise<AudioBuffer>
    BaseAudioContext.prototype.decodeAudioData = function (this: BaseAudioContext, data: ArrayBuffer) {
      const head = String.fromCharCode(...new Uint8Array(data, 0, 4))
      if (head === 'fLaC') return Promise.reject(new DOMException('Unable to decode audio data', 'EncodingError'))
      return decode.call(this, data)
    } as typeof BaseAudioContext.prototype.decodeAudioData
  })
}

const parseClock = (text: string): number => {
  const [m, s] = text.trim().split(':')
  return Number(m) * 60 + Number(s)
}

/** Page object for the desktop layout (library sidebar, stage, footer transport). */
export class PlayerPage {
  readonly footer: Locator

  constructor(readonly page: Page) {
    this.footer = page.locator('#player')
  }

  async open(): Promise<void> {
    await installAudioProbe(this.page)
    await installPolicyWatch(this.page)
    await this.page.goto('/')
    await this.ready()
  }

  /** What the page's Content-Security-Policy has blocked so far: an app that stays inside its policy has none. */
  async policyViolations(): Promise<PolicyViolation[]> {
    return this.page.evaluate(() => window.__csp ?? [])
  }

  async reload(): Promise<void> {
    await this.page.reload()
    await this.ready()
  }

  private async ready(): Promise<void> {
    await expect(this.viewSelect).toBeVisible()
  }

  // ---- library ----

  async importFiles(...files: Upload[]): Promise<void> {
    await this.page.locator('input[type=file]').first().setInputFiles(files)
  }

  /**
   * The tracks the app has saved in its own database, read straight from IndexedDB. Saving comes a moment after the
   * screen changes, so wait on this (with `expect.poll`) before a reload instead of sleeping for a guessed time.
   */
  async storedTracks(): Promise<StoredTrack[]> {
    return this.page.evaluate(
      () =>
        new Promise<StoredTrack[]>((resolve, reject) => {
          const open = indexedDB.open('wavelocal', 1)
          open.onsuccess = () => {
            const db = open.result
            const req = db.transaction('tracks', 'readonly').objectStore('tracks').getAll()
            req.onsuccess = () => {
              resolve(
                (req.result as { id: string; title: string; file: { name: string }; lyrics?: unknown }[])
                  .map((r) => ({ id: r.id, name: r.file.name, title: r.title, lyrics: !!r.lyrics }))
                  .sort((a, b) => a.name.localeCompare(b.name)),
              )
              db.close()
            }
            req.onerror = () => reject(req.error)
          }
          open.onerror = () => reject(open.error)
        }),
    )
  }

  /** One value of the app's `meta` store (order, playlists, the Up Next queue...) as saved, or undefined. */
  async storedMeta(key: string): Promise<unknown> {
    return this.page.evaluate(
      (key) =>
        new Promise<unknown>((resolve, reject) => {
          const open = indexedDB.open('wavelocal', 1)
          open.onsuccess = () => {
            const db = open.result
            const req = db.transaction('meta', 'readonly').objectStore('meta').get(key)
            req.onsuccess = () => {
              resolve(req.result)
              db.close()
            }
            req.onerror = () => reject(req.error)
          }
          open.onerror = () => reject(open.error)
        }),
      key,
    )
  }

  /** The waveform kept for a track (`peaks:<id>` in `meta`) with its arrays as plain numbers, or null when there is none. */
  async storedPeaks(id: string): Promise<{ v: number; duration: number; length: number; peak: number[]; rms: number[] } | { v: number; none: string } | null> {
    return this.page.evaluate(
      (key) =>
        new Promise<{ v: number; duration: number; length: number; peak: number[]; rms: number[] } | { v: number; none: string } | null>((resolve, reject) => {
          const open = indexedDB.open('wavelocal', 1)
          open.onsuccess = () => {
            const db = open.result
            const req = db.transaction('meta', 'readonly').objectStore('meta').get(key)
            req.onsuccess = () => {
              const value = req.result as { v: number; duration?: number; length?: number; peak?: Uint8Array; rms?: Uint8Array; none?: string } | undefined
              db.close()
              if (!value) return resolve(null)
              if (value.none) return resolve({ v: value.v, none: value.none })
              resolve({ v: value.v, duration: value.duration ?? 0, length: value.length ?? 0, peak: [...(value.peak ?? [])], rms: [...(value.rms ?? [])] })
            }
            req.onerror = () => reject(req.error)
          }
          open.onerror = () => reject(open.error)
        }),
      `peaks:${id}`,
    )
  }

  /** The main library sidebar (the phone queue sheet renders a second, hidden one later in the DOM). */
  get sidebar(): Locator {
    return this.page.locator('aside').first()
  }

  /** The center stage with artwork / lyrics tabs. */
  get stage(): Locator {
    return this.page.locator('section').first()
  }

  /** Track rows (virtualized spacers and the empty-state row are excluded). */
  get rows(): Locator {
    return this.sidebar.locator('ul > li').filter({ has: this.page.locator('button[aria-current]') })
  }

  row(title: string): Locator {
    return this.rows.filter({ has: this.page.locator('div.truncate.text-sm', { hasText: new RegExp(`^${escapeRegExp(title)}$`) }) })
  }

  async titles(): Promise<string[]> {
    return this.rows.locator('div.truncate.text-sm').allTextContents()
  }

  get viewSelect(): Locator {
    return this.sidebar.getByLabel('Library or playlist')
  }

  /** One of the tabs that switch the library panel between tracks, albums, artists and folders. */
  tab(name: 'Tracks' | 'Albums' | 'Artists' | 'Folders'): Locator {
    return this.sidebar.getByRole('tab', { name, exact: true })
  }

  /** Switch the library panel to a tab and wait until it has taken effect. */
  async showMode(name: 'Tracks' | 'Albums' | 'Artists' | 'Folders'): Promise<void> {
    await this.tab(name).click()
    await expect(this.tab(name)).toHaveAttribute('aria-selected', 'true')
  }

  get search(): Locator {
    return this.sidebar.getByLabel('Search tracks')
  }

  // ---- transport ----

  get playButton(): Locator {
    return this.footer.getByRole('button', { name: /^(Play|Pause) \(Space\)$/ })
  }

  async expectPlaying(): Promise<void> {
    await expect(this.playButton).toHaveAccessibleName('Pause (Space)')
  }

  async expectPaused(): Promise<void> {
    await expect(this.playButton).toHaveAccessibleName('Play (Space)')
  }

  /** Click a track row to start it. */
  async play(title: string): Promise<void> {
    await this.row(title).locator('button[aria-current]').click()
    await this.expectPlaying()
  }

  async next(): Promise<void> {
    await this.footer.getByRole('button', { name: 'Next (N)' }).click()
  }

  async previous(): Promise<void> {
    await this.footer.getByRole('button', { name: 'Previous (P)' }).click()
  }

  // ---- up next ----

  /** Queue a track from the menu of its row. */
  async queueTrack(title: string, action: 'Play next' | 'Add to queue'): Promise<void> {
    await this.row(title).hover()
    await this.row(title).getByRole('button', { name: `Add ${title} to playlist or queue` }).click()
    await this.page.getByRole('menuitem', { name: action, exact: true }).click()
  }

  /** The stage tab that lists what was queued by hand (its name carries the count). */
  get upNextTab(): Locator {
    return this.stage.getByRole('tab', { name: /^Up Next/ })
  }

  get upNextList(): Locator {
    return this.stage.getByRole('list', { name: 'Up Next' })
  }

  async showUpNext(): Promise<void> {
    await this.upNextTab.click()
    await expect(this.upNextTab).toHaveAttribute('aria-selected', 'true')
  }

  /** The titles in the Up Next list, in order. */
  async upNextTitles(): Promise<string[]> {
    return this.upNextList.locator('li div.truncate.text-sm').allTextContents()
  }

  get nowPlayingTitle(): Locator {
    return this.footer.locator('div.font-medium').first()
  }

  get seekBar(): Locator {
    return this.footer.getByRole('slider', { name: 'Seek' })
  }

  /** Playback position shown in the footer, in seconds. */
  async position(): Promise<number> {
    return parseClock(await this.footer.locator('span.w-10.text-right').innerText())
  }

  async duration(): Promise<number> {
    return parseClock(await this.footer.locator('span.w-10:not(.text-right)').innerText())
  }

  /** Wait until the active track's metadata is loaded (duration known), then seek. */
  async seekTo(seconds: number): Promise<void> {
    await expect.poll(() => this.duration()).toBeGreaterThan(seconds)
    await this.seekBar.fill(String(seconds))
  }

  /** Drop focus so global hotkeys (Space etc.) are not swallowed by a focused button. */
  async blur(): Promise<void> {
    await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  }

  async key(key: string): Promise<void> {
    await this.blur()
    await this.page.keyboard.press(key)
  }

  // ---- audio graph inspection ----

  /** Current value of a filter band's gain AudioParam (dB). */
  async filterGain(band: number): Promise<number> {
    return this.page.evaluate(([i, offset]) => window.__probe.filters[(i as number) + (offset as number)]?.gain.value ?? Number.NaN, [band, TONE_FILTERS] as const)
  }

  /** Current value of a gain node by its index in creation order (see GAIN). */
  async gainValue(index: number): Promise<number> {
    return this.page.evaluate((i) => window.__probe.gains[i]?.gain.value ?? Number.NaN, index)
  }

  /** The spatial panner's model and current automated position, with the audio clock reading it was taken at. */
  async panner(): Promise<{ model: string; x: number; y: number; z: number; time: number } | null> {
    return this.page.evaluate(() => {
      const p = window.__probe.panners[0]
      return p ? { model: p.panningModel, x: p.positionX.value, y: p.positionY.value, z: p.positionZ.value, time: p.context.currentTime } : null
    })
  }

  /** The reverb convolver's impulse response and the pre-delay line, or null before the audio graph exists. */
  async reverbNodes(): Promise<{
    hasBuffer: boolean
    channels: number
    seconds: number
    sampleRate: number
    normalize: boolean
    preDelaySeconds: number
    /** Energy of the left channel in the first 10 ms of the response. */
    onsetEnergy: number
  } | null> {
    return this.page.evaluate(() => {
      const c = window.__probe.convolvers[0]
      const d = window.__probe.delays[0]
      if (!c || !d) return null
      const b = c.buffer
      let onsetEnergy = 0
      if (b) {
        const left = b.getChannelData(0)
        for (let i = 0; i < Math.min(left.length, Math.round(b.sampleRate * 0.01)); i++) onsetEnergy += (left[i] ?? 0) ** 2
      }
      return {
        hasBuffer: b !== null,
        channels: b?.numberOfChannels ?? 0,
        seconds: b?.duration ?? 0,
        sampleRate: b?.sampleRate ?? 0,
        normalize: c.normalize,
        preDelaySeconds: d.delayTime.value,
        onsetEnergy,
      }
    })
  }

  /** The audio context's sample rate (needed to evaluate filter maths exactly as the browser does). */
  async sampleRate(): Promise<number> {
    return this.page.evaluate(() => window.__probe.gains[0]?.context.sampleRate ?? 0)
  }

  /** The equalizer filters that are really in the signal path between the EQ input and its "through" gain, in order. */
  async liveEqFilters(): Promise<{ type: string; frequency: number; q: number; gain: number }[]> {
    return this.page.evaluate(
      ([inIndex, throughIndex]) => {
        const { gains, edges } = window.__probe
        const start = gains[inIndex as number]
        const end = gains[throughIndex as number]
        const found: BiquadFilterNode[] = []
        let current: AudioNode | undefined = start
        for (let hops = 0; current && hops < 64; hops++) {
          const next: AudioNode | undefined = [...(edges.get(current) ?? [])].find((n) => n instanceof BiquadFilterNode || n === end)
          if (!next || next === end) break
          found.push(next as BiquadFilterNode)
          current = next
        }
        return found.map((f) => ({ type: f.type, frequency: f.frequency.value, q: f.Q.value, gain: f.gain.value }))
      },
      [GAIN.eqIn, GAIN.eqThrough],
    )
  }

  /** Combined response (dB) of the live equalizer chain at the given frequencies, measured by the browser itself. */
  async chainResponseDb(frequencies: number[]): Promise<number[]> {
    return this.page.evaluate(
      ([inIndex, throughIndex, freqs]) => {
        const { gains, edges } = window.__probe
        const end = gains[throughIndex as number]
        const f32 = Float32Array.from(freqs as number[])
        const total = new Array<number>(f32.length).fill(0)
        let current: AudioNode | undefined = gains[inIndex as number]
        for (let hops = 0; current && hops < 64; hops++) {
          const next: AudioNode | undefined = [...(edges.get(current) ?? [])].find((n) => n instanceof BiquadFilterNode || n === end)
          if (!next || next === end) break
          const mag = new Float32Array(f32.length)
          const phase = new Float32Array(f32.length)
          ;(next as BiquadFilterNode).getFrequencyResponse(f32, mag, phase)
          mag.forEach((m, i) => (total[i] = (total[i] ?? 0) + 20 * Math.log10(m)))
          current = next
        }
        return total
      },
      [GAIN.eqIn, GAIN.eqThrough, frequencies] as const,
    )
  }

  /** Compressor and limiter parameter values plus their current gain reduction. */
  async compressorState(index: 0 | 1): Promise<{ threshold: number; ratio: number; knee: number; attack: number; release: number; reduction: number } | null> {
    return this.page.evaluate((i) => {
      const c = window.__probe.compressors[i]
      return c ? { threshold: c.threshold.value, ratio: c.ratio.value, knee: c.knee.value, attack: c.attack.value, release: c.release.value, reduction: c.reduction } : null
    }, index)
  }

  /** Response (dB) of the bass and treble tone shelves at the given frequencies. */
  async toneResponseDb(frequencies: number[]): Promise<{ bass: number[]; treble: number[] }> {
    return this.page.evaluate((freqs) => {
      const [bass, treble] = window.__probe.filters
      const f32 = Float32Array.from(freqs)
      const measure = (node: BiquadFilterNode | undefined) => {
        const mag = new Float32Array(f32.length)
        const phase = new Float32Array(f32.length)
        node?.getFrequencyResponse(f32, mag, phase)
        return Array.from(mag, (m) => 20 * Math.log10(m))
      }
      return { bass: measure(bass), treble: measure(treble) }
    }, frequencies)
  }

  /** RMS and peak of the real output, per channel, in dBFS (the last ~90 ms). */
  async outputLevels(): Promise<{ leftRms: number; rightRms: number; leftPeak: number; rightPeak: number }> {
    return this.page.evaluate(() => {
      const taps = window.__probe.taps
      const level = (a: AnalyserNode | undefined) => {
        if (!a) return { rms: -Infinity, peak: -Infinity }
        const data = new Float32Array(a.fftSize)
        a.getFloatTimeDomainData(data)
        let sum = 0
        let peak = 0
        for (const v of data) {
          sum += v * v
          peak = Math.max(peak, Math.abs(v))
        }
        return { rms: 20 * Math.log10(Math.sqrt(sum / data.length)), peak: 20 * Math.log10(peak) }
      }
      const l = level(taps?.left)
      const r = level(taps?.right)
      return { leftRms: l.rms, rightRms: r.rms, leftPeak: l.peak, rightPeak: r.peak }
    })
  }

  /** Spectrum of the real output at the given frequencies (dB, strongest of the three nearest bins), per channel. */
  async outputSpectrumDb(frequencies: number[]): Promise<{ left: number[]; right: number[] }> {
    return this.page.evaluate((freqs) => {
      const taps = window.__probe.taps
      const read = (a: AnalyserNode | undefined) => {
        if (!a) return freqs.map(() => -Infinity)
        const bins = new Float32Array(a.frequencyBinCount)
        a.getFloatFrequencyData(bins)
        return freqs.map((f) => {
          const centre = Math.round((f / (a.context.sampleRate / 2)) * a.frequencyBinCount)
          return Math.max(bins[centre - 1] ?? -Infinity, bins[centre] ?? -Infinity, bins[centre + 1] ?? -Infinity)
        })
      }
      return { left: read(taps?.left), right: read(taps?.right) }
    }, frequencies)
  }

  /** The source the playing media element was given: its URL and the type and size of the Blob behind it. */
  async playingSource(): Promise<{ src: string; type: string; size: number } | null> {
    return this.page.evaluate(() => {
      const playing = [...window.__probe.media].find((m) => !m.paused)
      const src = playing?.getAttribute('src') ?? ''
      const blob = window.__probe.blobs.get(src)
      return playing && blob ? { src, type: blob.type, size: blob.size } : null
    })
  }

  /** Web Workers the page has started. */
  async workerCount(): Promise<number> {
    return this.page.evaluate(() => window.__probe.workers)
  }

  /** Object URLs the page has revoked so far. */
  async revokedUrls(): Promise<string[]> {
    return this.page.evaluate(() => [...window.__probe.revoked])
  }

  /** The type and size of a Blob behind an object URL the page created. */
  async blobInfo(url: string): Promise<{ type: string; size: number } | null> {
    return this.page.evaluate((u) => window.__probe.blobs.get(u) ?? null, url)
  }

  /** How many media elements are currently playing (2 during a crossfade overlap). */
  async playingElements(): Promise<number> {
    return this.page.evaluate(() => [...window.__probe.media].filter((m) => !m.paused && !m.ended).length)
  }

  /** Playback rate / pitch-preservation of every deck's media element. */
  async mediaSettings(): Promise<{ rate: number; preservesPitch: boolean }[]> {
    return this.page.evaluate(() => [...window.__probe.media].map((m) => ({ rate: m.playbackRate, preservesPitch: m.preservesPitch })))
  }

  // ---- dialogs ----

  /** The question the page is asking in its own dialog (a name to type, or a yes/no), when one is up. */
  get question(): Locator {
    return this.page.getByTestId('dialog')
  }

  /**
   * Answer the question the page is asking: type `text` if it wants a name, then confirm (`accept`) or cancel. Call it
   * after the click that opens the question; it waits for the question to appear, and for it to be gone.
   */
  async answerDialog(accept: boolean, text?: string): Promise<void> {
    await expect(this.question).toBeVisible()
    if (accept && text !== undefined) await this.question.getByRole('textbox').fill(text)
    await this.question.getByTestId(accept ? 'dialog-confirm' : 'dialog-cancel').click()
    await expect(this.question).toBeHidden()
  }

  /** A message the page shows for a few seconds (and its Undo, when it has one). */
  toast(text: string | RegExp): Locator {
    return this.page.getByRole('status').filter({ hasText: text })
  }

  /** Open the actions menu of the playlist that is showing and choose one of its items. */
  async playlistAction(name: string | RegExp): Promise<void> {
    await this.sidebar.getByRole('button', { name: 'Playlist actions' }).click()
    await this.page.getByRole('menuitem', { name }).click()
  }

  get tools(): Locator {
    return this.page.getByRole('dialog', { name: 'Sound and tools' })
  }

  async openTools(): Promise<void> {
    await this.footer.getByRole('button', { name: /^Equalizer, sleep timer/ }).click()
    await expect(this.tools).toBeVisible()
  }

  async closeTools(): Promise<void> {
    await this.tools.getByRole('button', { name: 'Close' }).click()
    await expect(this.tools).toBeHidden()
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
