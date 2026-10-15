import { expect } from '@playwright/test'
import type { Dialog, Locator, Page } from '@playwright/test'
import { buildFixture, lrcText } from '../src/test-utils/fixtures'
import { sine } from '../src/test-utils/signals'
import { encodeWav } from '../src/test-utils/wav'
import type { FixtureName } from '../src/test-utils/fixtures'

export interface Upload {
  name: string
  mimeType: string
  buffer: Buffer
}

/** A synthetic WAV fixture as an uploadable file. */
export const wav = (fixture: FixtureName, name = `${fixture}.wav`): Upload => ({
  name,
  mimeType: 'audio/wav',
  buffer: Buffer.from(buildFixture(fixture).bytes),
})

/** A sidecar lyrics file built from [seconds, text] pairs. */
export const lrc = (name: string, lines: readonly (readonly [seconds: number, text: string])[]): Upload => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from(lrcText(lines)),
})

/** A very short tone, for tests that need many cheap tracks. */
export const tone = (name: string, seconds = 0.1, frequency = 440): Upload => ({
  name,
  mimeType: 'audio/wav',
  buffer: Buffer.from(encodeWav([sine({ frequency, amplitude: 0.4, seconds })])),
})

/**
 * Everything the page created that tests may want to inspect: playing media elements, EQ filters and gain nodes.
 * Gain order follows AudioEngine.init(): [master, deck0.norm, deck0.crossfade, deck1.norm, deck1.crossfade, spatial.dry, spatial.wet, spatial.out].
 */
export interface AudioProbe {
  media: Set<HTMLMediaElement>
  filters: BiquadFilterNode[]
  gains: GainNode[]
  panners: PannerNode[]
}

declare global {
  interface Window {
    __probe: AudioProbe
  }
}

export const GAIN = { master: 0, deck0Norm: 1, deck0Fade: 2, deck1Norm: 3, deck1Fade: 4, spatialDry: 5, spatialWet: 6, spatialOut: 7 } as const

/** Record media elements and audio nodes created by the app (must run before the page loads). */
export async function installAudioProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: AudioProbe = { media: new Set(), filters: [], gains: [], panners: [] }
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
    const panner = AudioContext.prototype.createPanner
    AudioContext.prototype.createPanner = function (this: AudioContext) {
      const node = panner.call(this)
      probe.panners.push(node)
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

const parseClock = (text: string): number => {
  const [m, s] = text.trim().split(':')
  return Number(m) * 60 + Number(s)
}

/** Page object for the desktop layout (library sidebar, stage, footer transport). */
export class PlayerPage {
  readonly footer: Locator

  constructor(readonly page: Page) {
    this.footer = page.locator('footer')
  }

  async open(): Promise<void> {
    await installAudioProbe(this.page)
    await this.page.goto('/')
    await this.ready()
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
    return this.page.evaluate((i) => window.__probe.filters[i]?.gain.value ?? Number.NaN, band)
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

  /** How many media elements are currently playing (2 during a crossfade overlap). */
  async playingElements(): Promise<number> {
    return this.page.evaluate(() => [...window.__probe.media].filter((m) => !m.paused && !m.ended).length)
  }

  /** Playback rate / pitch-preservation of every deck's media element. */
  async mediaSettings(): Promise<{ rate: number; preservesPitch: boolean }[]> {
    return this.page.evaluate(() => [...window.__probe.media].map((m) => ({ rate: m.playbackRate, preservesPitch: m.preservesPitch })))
  }

  // ---- dialogs ----

  /** Answer the next window.prompt / confirm. */
  answerNextDialog(accept: boolean, text?: string): void {
    this.page.once('dialog', (d: Dialog) => void (accept ? d.accept(text) : d.dismiss()))
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
