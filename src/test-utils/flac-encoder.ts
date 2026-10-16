import { crc16, crc8 } from '../lib/audio/crc'
import { Md5 } from '../lib/audio/md5'

/**
 * A small FLAC *encoder* used only to manufacture test fixtures: it can produce every kind of stream the decoder
 * has to understand (constant / verbatim / fixed / LPC subframes, Rice and Rice2 residuals with escape partitions,
 * wasted bits, all four channel assignments, fixed and variable block sizes, seek tables, tags, ID3v2 prefixes).
 * It is not tuned for compression ratio.
 */

export type SubframeMode = 'auto' | 'constant' | 'verbatim' | 'fixed' | 'lpc'
export type StereoMode = 'auto' | 'independent' | 'leftside' | 'rightside' | 'midside'

export interface FlacEncodeOptions {
  sampleRate: number
  bitsPerSample: number
  /** Fixed block size in samples (default 4096). */
  blockSize?: number
  /** Explicit block sizes, repeated as needed; switches the stream to the variable block size strategy. */
  blockSizes?: number[]
  subframe?: SubframeMode
  /** Predictor order for `fixed` (0-4, default 2) or `lpc` (1-32, default 8). */
  order?: number
  lpcPrecision?: number
  stereo?: StereoMode
  /** 0 = 4-bit Rice parameters, 1 = 5-bit (Rice2). Default: whichever fits. */
  riceMethod?: 0 | 1
  maxPartitionOrder?: number
  /** Allow escape partitions (raw samples) when they are cheaper. Default true. */
  allowEscape?: boolean
  /** Spot samples whose low bits are all zero and signal them as wasted bits. Default true. */
  wastedBits?: boolean
  /** Use sample-rate code 0 (take the rate from STREAMINFO) in frame headers. */
  rateFromStreamInfo?: boolean
  /** Add a SEEKTABLE with a point every N frames. */
  seekEvery?: number
  vorbis?: { vendor: string; comments: string[] }
  /** Cover art, written as a PICTURE metadata block (front cover, no description). */
  picture?: { mime: string; data: Uint8Array }
  /** Bytes of PADDING metadata. */
  padding?: number
  /** An ID3v2 tag to put in front of the stream. */
  id3v2?: Uint8Array
  /** Store the MD5 / the total sample count. Both default to true. */
  writeMd5?: boolean
  writeTotalSamples?: boolean
}

// ---- bit writer ----

class BitWriter {
  private buffer = new Uint8Array(4096)
  private size = 0
  private current = 0
  private filled = 0

  get bitLength(): number {
    return this.size * 8 + this.filled
  }

  write(value: number, bits: number): void {
    let remaining = bits
    while (remaining > 0) {
      const take = Math.min(remaining, 8 - this.filled)
      const shift = remaining - take
      const part = Math.floor(value / 2 ** shift) % (1 << take)
      this.current = (this.current << take) | part
      this.filled += take
      remaining -= take
      if (this.filled === 8) {
        this.pushByte(this.current)
        this.current = 0
        this.filled = 0
      }
    }
  }

  writeSigned(value: number, bits: number): void {
    this.write(value < 0 ? value + 2 ** bits : value, bits)
  }

  writeUnary(count: number): void {
    for (let i = 0; i < count; i++) this.write(0, 1)
    this.write(1, 1)
  }

  alignZero(): void {
    if (this.filled > 0) this.write(0, 8 - this.filled)
  }

  /** The whole-byte contents; call `alignZero()` first. */
  bytes(): Uint8Array {
    return this.buffer.slice(0, this.size)
  }

  private pushByte(byte: number): void {
    if (this.size === this.buffer.length) {
      const bigger = new Uint8Array(this.buffer.length * 2)
      bigger.set(this.buffer)
      this.buffer = bigger
    }
    this.buffer[this.size++] = byte
  }
}

// ---- residual coding ----

const zigzag = (v: number): number => (v >= 0 ? 2 * v : -2 * v - 1)

interface ResidualPlan {
  method: 0 | 1
  partitionOrder: number
  /** Rice parameter per partition, or -1 for an escape partition. */
  params: number[]
  /** Raw bit width for escape partitions. */
  rawBits: number[]
  bits: number
}

const signedBits = (v: number): number => (v === 0 ? 0 : v > 0 ? Math.floor(Math.log2(v)) + 2 : Math.floor(Math.log2(-v - 1 || 1)) + 2)

function planResidual(res: Int32Array, blockSize: number, order: number, opts: FlacEncodeOptions): ResidualPlan {
  const maxOrder = opts.maxPartitionOrder ?? 4
  let best: ResidualPlan | null = null
  for (let p = 0; p <= maxOrder; p++) {
    const partitions = 1 << p
    if (blockSize % partitions !== 0 || blockSize >> p <= order) continue
    const per = blockSize >> p
    const params: number[] = []
    const rawBits: number[] = []
    const costs: { rice: number; k: number; escape: number }[] = []
    let anyBig = false
    for (let part = 0; part < partitions; part++) {
      const from = part === 0 ? order : part * per
      const to = (part + 1) * per
      const values: number[] = []
      let rawWidth = 0
      for (let i = from; i < to; i++) {
        const v = res[i] ?? 0
        values.push(zigzag(v))
        rawWidth = Math.max(rawWidth, signedBits(v))
      }
      let bestK = 0
      let bestRice = Infinity
      for (let k = 0; k <= 30; k++) {
        let total = 0
        for (const u of values) total += Math.floor(u / 2 ** k) + 1 + k
        if (total < bestRice) {
          bestRice = total
          bestK = k
        }
      }
      costs.push({ rice: bestRice, k: bestK, escape: (opts.allowEscape ?? true) ? values.length * rawWidth : Infinity })
      rawBits.push(rawWidth)
      if (bestK > 14) anyBig = true
    }
    const method: 0 | 1 = opts.riceMethod ?? (anyBig ? 1 : 0)
    const maxK = method === 0 ? 14 : 30
    let bits = 6 // method + partition order
    for (const c of costs) {
      const k = Math.min(c.k, maxK)
      const rice = k === c.k ? c.rice : Infinity
      const useEscape = c.escape + 5 < rice
      bits += (method === 0 ? 4 : 5) + (useEscape ? 5 + c.escape : rice)
      params.push(useEscape ? -1 : k)
    }
    // a partition forced above the largest legal Rice parameter must escape; if even that is impossible skip this order
    if (params.some((k, i) => k === -1 && !Number.isFinite(costs[i]?.escape ?? Infinity))) continue
    const plan: ResidualPlan = { method, partitionOrder: p, params, rawBits, bits }
    if (!best || plan.bits < best.bits) best = plan
  }
  if (!best) throw new Error('Cannot partition residual')
  return best
}

function writeResidual(bw: BitWriter, res: Int32Array, blockSize: number, order: number, plan: ResidualPlan): void {
  bw.write(plan.method, 2)
  bw.write(plan.partitionOrder, 4)
  const per = blockSize >> plan.partitionOrder
  const paramBits = plan.method === 0 ? 4 : 5
  const escapeCode = plan.method === 0 ? 15 : 31
  plan.params.forEach((k, part) => {
    const from = part === 0 ? order : part * per
    const to = (part + 1) * per
    if (k === -1) {
      bw.write(escapeCode, paramBits)
      const width = plan.rawBits[part] ?? 0
      bw.write(width, 5)
      for (let i = from; i < to; i++) bw.writeSigned(res[i] ?? 0, width)
      return
    }
    bw.write(k, paramBits)
    for (let i = from; i < to; i++) {
      const u = zigzag(res[i] ?? 0)
      bw.writeUnary(Math.floor(u / 2 ** k))
      if (k > 0) bw.write(u % 2 ** k, k)
    }
  })
}

// ---- predictors ----

function fixedResidual(x: Int32Array, order: number): Int32Array {
  const n = x.length
  const r = new Int32Array(n)
  for (let i = order; i < n; i++) {
    const a = x[i - 1] ?? 0
    const b = x[i - 2] ?? 0
    const c = x[i - 3] ?? 0
    const d = x[i - 4] ?? 0
    const predicted = order === 0 ? 0 : order === 1 ? a : order === 2 ? 2 * a - b : order === 3 ? 3 * a - 3 * b + c : 4 * a - 6 * b + 4 * c - d
    r[i] = (x[i] ?? 0) - predicted
  }
  return r
}

/** Linear-prediction coefficients of orders 1..maxOrder (Levinson-Durbin on a windowed autocorrelation). */
function lpcByOrder(x: Int32Array, maxOrder: number): number[][] {
  const n = x.length
  const windowed = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0
    const w = t < 0.25 ? 0.5 - 0.5 * Math.cos((4 * Math.PI * t)) : t > 0.75 ? 0.5 - 0.5 * Math.cos(4 * Math.PI * (1 - t)) : 1 // Tukey(0.5)
    windowed[i] = (x[i] ?? 0) * w
  }
  const r = new Float64Array(maxOrder + 1)
  for (let lag = 0; lag <= maxOrder; lag++) {
    let s = 0
    for (let i = lag; i < n; i++) s += (windowed[i] ?? 0) * (windowed[i - lag] ?? 0)
    r[lag] = s
  }
  const out: number[][] = []
  if ((r[0] ?? 0) <= 0) return out
  r[0] = (r[0] ?? 0) * (1 + 1e-9)
  let error = r[0] ?? 0
  let a: number[] = []
  for (let m = 1; m <= maxOrder; m++) {
    let acc = r[m] ?? 0
    for (let j = 1; j < m; j++) acc -= (a[j - 1] ?? 0) * (r[m - j] ?? 0)
    const k = acc / error
    const next = a.slice()
    next[m - 1] = k
    for (let j = 1; j < m; j++) next[j - 1] = (a[j - 1] ?? 0) - k * (a[m - 1 - j] ?? 0)
    a = next
    error *= 1 - k * k
    out.push(a.slice())
    if (error <= 0) break
  }
  return out
}

function quantizeLpc(coefficients: number[], precision: number): { q: Int32Array; shift: number } | null {
  const cmax = Math.max(...coefficients.map(Math.abs))
  if (!(cmax > 0)) return null
  const limit = 2 ** (precision - 1) - 1
  const shift = Math.min(15, Math.floor(Math.log2(limit / cmax)))
  if (shift < 0) return null
  const q = new Int32Array(coefficients.length)
  let carry = 0
  coefficients.forEach((c, i) => {
    const scaled = c * 2 ** shift + carry
    const rounded = Math.max(-limit - 1, Math.min(limit, Math.round(scaled)))
    carry = scaled - rounded
    q[i] = rounded
  })
  return { q, shift }
}

function lpcResidual(x: Int32Array, q: Int32Array, shift: number): Int32Array {
  const order = q.length
  const n = x.length
  const r = new Int32Array(n)
  const divisor = 2 ** shift
  for (let i = order; i < n; i++) {
    let sum = 0
    for (let j = 0; j < order; j++) sum += (q[j] ?? 0) * (x[i - 1 - j] ?? 0)
    r[i] = (x[i] ?? 0) - Math.floor(sum / divisor)
  }
  return r
}

// ---- subframes ----

interface SubframePlan {
  type: 'constant' | 'verbatim' | 'fixed' | 'lpc'
  samples: Int32Array
  bps: number
  wasted: number
  order: number
  residual?: Int32Array
  residualPlan?: ResidualPlan
  coefficients?: Int32Array
  precision?: number
  shift?: number
  bits: number
}

function wastedBitsOf(x: Int32Array): number {
  let acc = 0
  for (const v of x) acc |= v
  if (acc === 0) return 0
  let w = 0
  while ((acc & 1) === 0) {
    acc >>= 1
    w++
  }
  return w
}

function planSubframe(input: Int32Array, bps: number, opts: FlacEncodeOptions): SubframePlan {
  const wasted = (opts.wastedBits ?? true) ? wastedBitsOf(input) : 0
  const x = wasted ? input.map((v) => v >> wasted) : input
  const eff = bps - wasted
  const n = x.length
  const headerBits = 8 + (wasted ? wasted : 0)
  const mode = opts.subframe ?? 'auto'
  const plans: SubframePlan[] = []

  const allEqual = x.every((v) => v === x[0])
  if (allEqual && (mode === 'auto' || mode === 'constant')) {
    plans.push({ type: 'constant', samples: x, bps, wasted, order: 0, bits: headerBits + eff })
  }
  if (mode === 'constant' && !allEqual) throw new Error('constant mode needs constant samples')
  if (mode === 'verbatim' || mode === 'auto') plans.push({ type: 'verbatim', samples: x, bps, wasted, order: 0, bits: headerBits + n * eff })

  const addFixed = (order: number) => {
    if (order >= n && order > 0) return // no room left for a residual
    const residual = fixedResidual(x, order)
    const residualPlan = planResidual(residual, n, order, opts)
    plans.push({ type: 'fixed', samples: x, bps, wasted, order, residual, residualPlan, bits: headerBits + order * eff + residualPlan.bits })
  }
  if (mode === 'fixed') addFixed(opts.order ?? 2)
  if (mode === 'auto') for (let o = 0; o <= 4; o++) addFixed(o)

  const addLpc = (order: number) => {
    if (order >= n) return
    const precision = opts.lpcPrecision ?? 14
    const set = lpcByOrder(x, order)
    const coefficients = set[order - 1]
    if (!coefficients) return
    const quantized = quantizeLpc(coefficients, precision)
    if (!quantized) return
    const residual = lpcResidual(x, quantized.q, quantized.shift)
    const residualPlan = planResidual(residual, n, order, opts)
    plans.push({
      type: 'lpc',
      samples: x,
      bps,
      wasted,
      order,
      residual,
      residualPlan,
      coefficients: quantized.q,
      precision,
      shift: quantized.shift,
      bits: headerBits + order * eff + 9 + order * precision + residualPlan.bits,
    })
  }
  if (mode === 'lpc') addLpc(opts.order ?? 8)
  if (mode === 'auto') for (const o of [2, 4, 8, 12]) addLpc(o)

  if (plans.length === 0) {
    plans.push({ type: 'verbatim', samples: x, bps, wasted, order: 0, bits: headerBits + n * eff })
  }
  return plans.reduce((a, b) => (b.bits < a.bits ? b : a))
}

function writeSubframe(bw: BitWriter, plan: SubframePlan): void {
  const eff = plan.bps - plan.wasted
  const n = plan.samples.length
  bw.write(0, 1)
  const typeCode = plan.type === 'constant' ? 0 : plan.type === 'verbatim' ? 1 : plan.type === 'fixed' ? 8 + plan.order : 32 + plan.order - 1
  bw.write(typeCode, 6)
  if (plan.wasted > 0) {
    bw.write(1, 1)
    bw.writeUnary(plan.wasted - 1)
  } else bw.write(0, 1)

  if (plan.type === 'constant') {
    bw.writeSigned(plan.samples[0] ?? 0, eff)
  } else if (plan.type === 'verbatim') {
    for (let i = 0; i < n; i++) bw.writeSigned(plan.samples[i] ?? 0, eff)
  } else {
    for (let i = 0; i < plan.order; i++) bw.writeSigned(plan.samples[i] ?? 0, eff)
    if (plan.type === 'lpc') {
      bw.write((plan.precision ?? 14) - 1, 4)
      bw.writeSigned(plan.shift ?? 0, 5)
      plan.coefficients?.forEach((c) => bw.writeSigned(c, plan.precision ?? 14))
    }
    if (plan.residual && plan.residualPlan) writeResidual(bw, plan.residual, n, plan.order, plan.residualPlan)
  }
}

// ---- frames ----

const BLOCK_CODES: [number, number][] = [[192, 1], [576, 2], [1152, 3], [2304, 4], [4608, 5], [256, 8], [512, 9], [1024, 10], [2048, 11], [4096, 12], [8192, 13], [16384, 14], [32768, 15]]
const RATE_CODES: [number, number][] = [[88200, 1], [176400, 2], [192000, 3], [8000, 4], [16000, 5], [22050, 6], [24000, 7], [32000, 8], [44100, 9], [48000, 10], [96000, 11]]
const SIZE_CODES: Record<number, number> = { 8: 1, 12: 2, 16: 4, 20: 5, 24: 6 }

function writeUtf8Number(bw: BitWriter, value: number): void {
  if (value < 0x80) return bw.write(value, 8)
  let extra = 1
  while (value >= 2 ** (6 * extra + (7 - extra - 1)) && extra < 6) extra++
  const lead = [0, 0xc0, 0xe0, 0xf0, 0xf8, 0xfc, 0xfe][extra] ?? 0xc0
  bw.write(lead | Math.floor(value / 2 ** (6 * extra)), 8)
  for (let i = extra - 1; i >= 0; i--) bw.write(0x80 | (Math.floor(value / 2 ** (6 * i)) % 64), 8)
}

interface EncodedFrame {
  bytes: Uint8Array
  blockSize: number
  firstSample: number
}

function encodeFrame(channels: Int32Array[], start: number, size: number, frameIndex: number, opts: FlacEncodeOptions, variable: boolean): EncodedFrame {
  const bps = opts.bitsPerSample
  const slice = channels.map((c) => c.slice(start, start + size))
  const left = slice[0] ?? new Int32Array(size)
  const right = slice[1]

  let assignment = slice.length - 1
  let planned: SubframePlan[]
  if (slice.length === 2 && right) {
    const side = left.map((v, i) => v - (right[i] ?? 0))
    const mid = left.map((v, i) => (v + (right[i] ?? 0)) >> 1)
    const options: Record<Exclude<StereoMode, 'auto'>, () => SubframePlan[]> = {
      independent: () => [planSubframe(left, bps, opts), planSubframe(right, bps, opts)],
      leftside: () => [planSubframe(left, bps, opts), planSubframe(side, bps + 1, opts)],
      rightside: () => [planSubframe(side, bps + 1, opts), planSubframe(right, bps, opts)],
      midside: () => [planSubframe(mid, bps, opts), planSubframe(side, bps + 1, opts)],
    }
    const codes = { independent: 1, leftside: 8, rightside: 9, midside: 10 } as const
    const requested = opts.stereo ?? 'auto'
    const names = (requested === 'auto' ? ['independent', 'leftside', 'rightside', 'midside'] : [requested]) as Exclude<StereoMode, 'auto'>[]
    let best: { name: Exclude<StereoMode, 'auto'>; plans: SubframePlan[]; bits: number } | null = null
    for (const name of names) {
      const plans = options[name]()
      const bits = plans.reduce((s, p) => s + p.bits, 0)
      if (!best || bits < best.bits) best = { name, plans, bits }
    }
    if (!best) throw new Error('no stereo mode')
    planned = best.plans
    assignment = codes[best.name]
  } else {
    planned = slice.map((c) => planSubframe(c, bps, opts))
  }

  const bw = new BitWriter()
  bw.write(0x3ffe, 14)
  bw.write(0, 1)
  bw.write(variable ? 1 : 0, 1)
  const blockCode = BLOCK_CODES.find(([n]) => n === size)?.[1] ?? (size <= 256 ? 6 : 7)
  bw.write(blockCode, 4)
  const rate = opts.sampleRate
  const rateCode = opts.rateFromStreamInfo ? 0 : (RATE_CODES.find(([r]) => r === rate)?.[1] ?? (rate % 1000 === 0 && rate / 1000 <= 255 ? 12 : rate <= 65535 ? 13 : rate % 10 === 0 && rate / 10 <= 65535 ? 14 : 0))
  bw.write(rateCode, 4)
  bw.write(assignment, 4)
  bw.write(SIZE_CODES[bps] ?? 0, 3)
  bw.write(0, 1)
  writeUtf8Number(bw, variable ? start : frameIndex)
  if (blockCode === 6) bw.write(size - 1, 8)
  if (blockCode === 7) bw.write(size - 1, 16)
  if (rateCode === 12) bw.write(rate / 1000, 8)
  if (rateCode === 13) bw.write(rate, 16)
  if (rateCode === 14) bw.write(rate / 10, 16)
  const headerBytes = bw.bytes()
  bw.write(crc8(headerBytes), 8)

  for (const plan of planned) writeSubframe(bw, plan)
  bw.alignZero()
  const body = bw.bytes()
  const out = new Uint8Array(body.length + 2)
  out.set(body)
  const crc = crc16(body)
  out[body.length] = crc >> 8
  out[body.length + 1] = crc & 0xff
  return { bytes: out, blockSize: size, firstSample: start }
}

// ---- stream ----

function metadataBlock(type: number, last: boolean, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length)
  out[0] = (last ? 0x80 : 0) | type
  out[1] = (body.length >> 16) & 0xff
  out[2] = (body.length >> 8) & 0xff
  out[3] = body.length & 0xff
  out.set(body, 4)
  return out
}

/** Encode integer PCM (one Int32Array per channel, values within the bit depth) as a FLAC file. */
export function encodeFlac(channels: Int32Array[], options: FlacEncodeOptions): Uint8Array<ArrayBuffer> {
  const total = channels[0]?.length ?? 0
  const bps = options.bitsPerSample
  const sizes = options.blockSizes && options.blockSizes.length > 0 ? options.blockSizes : null
  const fixedSize = options.blockSize ?? 4096

  const frames: EncodedFrame[] = []
  let pos = 0
  let index = 0
  while (pos < total) {
    const wanted = sizes ? (sizes[index % sizes.length] ?? fixedSize) : fixedSize
    const size = Math.min(wanted, total - pos)
    frames.push(encodeFrame(channels, pos, size, index, options, sizes !== null))
    pos += size
    index++
  }

  // STREAMINFO
  const frameSizes = frames.map((f) => f.bytes.length)
  const blockSizesUsed = frames.map((f) => f.blockSize)
  const info = new BitWriter()
  info.write(blockSizesUsed.length ? Math.min(...blockSizesUsed) : fixedSize, 16)
  info.write(blockSizesUsed.length ? Math.max(...blockSizesUsed) : fixedSize, 16)
  info.write(frameSizes.length ? Math.min(...frameSizes) : 0, 24)
  info.write(frameSizes.length ? Math.max(...frameSizes) : 0, 24)
  info.write(options.sampleRate, 20)
  info.write(channels.length - 1, 3)
  info.write(bps - 1, 5)
  info.write(options.writeTotalSamples === false ? 0 : total, 36)
  const md5 = new Md5()
  if (options.writeMd5 !== false) {
    const width = Math.ceil(bps / 8)
    const bytes = new Uint8Array(total * channels.length * width)
    let o = 0
    for (let i = 0; i < total; i++) {
      for (const ch of channels) {
        const v = ch[i] ?? 0
        for (let b = 0; b < width; b++) bytes[o++] = (v >> (8 * b)) & 0xff
      }
    }
    md5.update(bytes)
  }
  const digest = options.writeMd5 === false ? new Uint8Array(16) : md5.digest()
  digest.forEach((b) => info.write(b, 8))
  const streamInfo = info.bytes()

  const blocks: { type: number; body: Uint8Array }[] = [{ type: 0, body: streamInfo }]
  if (options.seekEvery) {
    const points: number[] = []
    let offset = 0
    frames.forEach((f, i) => {
      if (i % options.seekEvery! === 0) points.push(f.firstSample, offset, f.blockSize)
      offset += f.bytes.length
    })
    const body = new Uint8Array((points.length / 3) * 18)
    const view = new DataView(body.buffer)
    for (let p = 0; p < points.length; p += 3) {
      const at = (p / 3) * 18
      const [sample, off, count] = [points[p] ?? 0, points[p + 1] ?? 0, points[p + 2] ?? 0]
      view.setUint32(at, Math.floor(sample / 4294967296), false)
      view.setUint32(at + 4, sample >>> 0, false)
      view.setUint32(at + 8, Math.floor(off / 4294967296), false)
      view.setUint32(at + 12, off >>> 0, false)
      view.setUint16(at + 16, count, false)
    }
    blocks.push({ type: 3, body })
  }
  if (options.vorbis) {
    const enc = new TextEncoder()
    const vendor = enc.encode(options.vorbis.vendor)
    const comments = options.vorbis.comments.map((c) => enc.encode(c))
    const body = new Uint8Array(8 + vendor.length + comments.reduce((n, c) => n + 4 + c.length, 0))
    const view = new DataView(body.buffer)
    view.setUint32(0, vendor.length, true)
    body.set(vendor, 4)
    let p = 4 + vendor.length
    view.setUint32(p, comments.length, true)
    p += 4
    for (const c of comments) {
      view.setUint32(p, c.length, true)
      body.set(c, p + 4)
      p += 4 + c.length
    }
    blocks.push({ type: 4, body })
  }
  if (options.picture) {
    const mime = new TextEncoder().encode(options.picture.mime)
    const data = options.picture.data
    const body = new Uint8Array(32 + mime.length + data.length)
    const view = new DataView(body.buffer)
    view.setUint32(0, 3, false) // front cover
    view.setUint32(4, mime.length, false)
    body.set(mime, 8)
    let p = 8 + mime.length
    view.setUint32(p, 0, false) // empty description
    // width, height, colour depth, indexed colours: left at 0 (unknown)
    p += 4 + 16
    view.setUint32(p, data.length, false)
    body.set(data, p + 4)
    blocks.push({ type: 6, body })
  }
  if (options.padding) blocks.push({ type: 1, body: new Uint8Array(options.padding) })

  const parts: Uint8Array[] = []
  if (options.id3v2) parts.push(options.id3v2)
  parts.push(Uint8Array.of(0x66, 0x4c, 0x61, 0x43)) // "fLaC"
  blocks.forEach((b, i) => parts.push(metadataBlock(b.type, i === blocks.length - 1, b.body)))
  for (const f of frames) parts.push(f.bytes)

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Float samples in [-1, 1] to integers of the given bit depth (full scale = +-(2^(bits-1) - 1)). */
export function floatToInt(samples: Float32Array, bitsPerSample: number): Int32Array {
  const scale = 2 ** (bitsPerSample - 1) - 1
  return Int32Array.from(samples, (v) => Math.max(-scale - 1, Math.min(scale, Math.round(v * scale))))
}
