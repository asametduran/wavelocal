/**
 * Clock alignment between two devices (NTP-style). A ping carries the sender's send time `t0`; the reply adds the
 * responder's receive time `t1` and send time `t2`; the sender notes its receive time `t3`. Then
 *   offset = ((t1 - t0) + (t2 - t3)) / 2     (responder clock minus local clock)
 *   rtt    = (t3 - t0) - (t2 - t1)
 * The error of one sample is bounded by half its round trip, so the estimate uses the samples with the smallest rtt.
 */

export interface ClockSample {
  offset: number
  rtt: number
}

export interface ClockEstimate extends ClockSample {
  samples: number
}

export function sampleFrom(t0: number, t1: number, t2: number, t3: number): ClockSample | null {
  const rtt = t3 - t0 - (t2 - t1)
  // a negative round trip means a clock jumped (or a forged reply): throw the sample away
  if (![t0, t1, t2, t3].every(Number.isFinite) || rtt < 0 || t3 < t0) return null
  return { offset: (t1 - t0 + (t2 - t3)) / 2, rtt }
}

export class ClockSync {
  private readonly window: ClockSample[] = []

  constructor(private readonly keep = 12) {}

  add(sample: ClockSample | null): void {
    if (!sample) return
    this.window.push(sample)
    if (this.window.length > this.keep) this.window.shift()
  }

  /** Median offset of the three lowest-latency recent samples, or null before the first reply. */
  estimate(): ClockEstimate | null {
    if (!this.window.length) return null
    const best = [...this.window].sort((a, b) => a.rtt - b.rtt).slice(0, 3)
    const offsets = best.map((s) => s.offset).sort((a, b) => a - b)
    const offset = offsets[Math.floor(offsets.length / 2)] as number
    return { offset, rtt: (best[0] as ClockSample).rtt, samples: this.window.length }
  }

  reset(): void {
    this.window.length = 0
  }
}
