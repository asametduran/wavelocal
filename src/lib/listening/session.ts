import { formatTime } from '../format'
import { classify, planSpeed, rememberSpeed, resumeAt, SAVE_EVERY_MS } from './progress'
import type { Progress } from './progress'
import type { ProgressService } from './progressservice'

/**
 * What a person gets from a long recording, as one set of rules apart from the screen and the player: it is taken up where it was
 * left, the place is kept while it plays, and its speed is its own. The page tells the session what the player is doing
 * (`update`, a few times a second) and the session answers through the player's hands (`SessionPort`). Nothing here reads a clock,
 * a timer or the database directly, so the whole of it is tested with a hand-wound clock and a memory database.
 */

/** What the session is told about the player each time something it cares about changes. */
export interface Moment {
  /** The library key of the playing track, or null when none plays (or when the host of a shared session is in charge). */
  key: string | null
  /** Whether that track is a long recording: by its length and the length the person chose, unless they said otherwise for it. */
  long: boolean
  playing: boolean
  /** Where the playhead was last reported, in seconds. */
  time: number
  /** How long the track is, in seconds (0 when not known). */
  duration: number
  /** The speed the player is set to. */
  speed: number
}

/** What the session asks of the page: the player's hands and the little that is kept outside the database. */
export interface SessionPort {
  /** The exact playhead of the playing track, in seconds. */
  position(): number
  seek(seconds: number): void
  setSpeed(speed: number): void
  /** The speed the person listens to songs at, as kept on this device; null when none is kept yet. */
  readUsualSpeed(): number | null
  writeUsualSpeed(speed: number): void
  toast(text: string, action: { label: string; run: () => void }): void
  /** Milliseconds, on any clock that does not run backwards. */
  now(): number
}

export type SessionStore = Pick<ProgressService, 'get' | 'save'>

/** A recording is taken up only from its beginning: a playhead already further than this (seconds) is where the person is. */
const AT_START = 1
/** The playhead has reached the place it was sent to when it is this near it (seconds); a compressed file lands a little off. */
const ARRIVED = 1.5
/** Two reports of a playhead that plays on are nearer than this (seconds); a jump is further. */
const A_STEP = 3

/** One stay with one track. */
interface Visit {
  key: string
  /**
   * The first track of the page. The player has usually put its playhead back where it was left by the time the session hears of
   * it (its own saved position is applied as soon as the file is read, and this code loads later), so that playhead is not a sign
   * that the person has moved on: the recording is taken up all the same, whichever of the two happens to come first.
   */
  first: boolean
  long: boolean
  /** Whether the track has played during the visit: a place is only kept for a recording that was listened to, never for one that was only opened. */
  played: boolean
  /**
   * The place the playhead was sent to and has not been seen at yet. Until it is, what the player reports is not where the person
   * is (the file may not have been read yet, and a playhead still at the start would be taken for a place), so nothing is kept.
   */
  awaiting: number | null
  lastSavedAt: number
  /** The speed the session last put the player at, or last saw the person choose: a report of any other speed is a choice. */
  speed: number
}

const sameSpeed = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6

export class LongFormSession {
  private visit: Visit | null = null
  private last: Moment | null = null
  private usual: number | null = null
  private visits = 0

  constructor(private readonly deps: { store: SessionStore; port: SessionPort }) {}

  /** The player moved on: it is another track, or it plays or stops, or the playhead or the speed changed. */
  update(m: Moment): void {
    const prev = this.last
    this.last = m
    if (m.key !== (this.visit?.key ?? null)) {
      this.leave(prev)
      this.enter(m)
      return
    }
    const visit = this.visit
    if (!visit || !prev) return
    if (m.long !== visit.long) this.becameLong(visit, m)
    this.watchSpeed(visit, prev, m)
    this.watchPlayhead(visit, prev, m)
  }

  /** The page is going away (closed, hidden, sent to the background): keep the place now, from where the player really is. */
  flush(): void {
    if (this.last) this.keep(this.deps.port.position(), this.last.duration)
  }

  /** Nothing more to look after: keep the place of the recording being heard and forget it. */
  close(): void {
    this.leave(this.last)
    this.last = null
    this.visits = 0
  }

  // ---- coming and going ----

  private enter(m: Moment): void {
    if (m.key === null) return
    const record = this.deps.store.get(m.key)
    const visit: Visit = { key: m.key, first: this.visits++ === 0, long: m.long, played: false, awaiting: null, lastSavedAt: this.deps.port.now(), speed: m.speed }
    this.visit = visit
    this.applySpeed(visit, m, record)
    if (m.long) this.resume(visit, m, record)
  }

  private leave(prev: Moment | null): void {
    if (prev) this.keep(prev.time, prev.duration)
    this.visit = null
  }

  /** The length of the file became known, or the person changed the rule: a track is a long recording now, or is no longer one. */
  private becameLong(visit: Visit, m: Moment): void {
    visit.long = m.long
    const record = this.deps.store.get(visit.key)
    this.applySpeed(visit, m, record)
    if (m.long) this.resume(visit, m, record)
  }

  // ---- the place ----

  private resume(visit: Visit, m: Moment, record: Progress | null): void {
    const place = record?.t ?? null
    if (place === null || !(visit.first || m.time < AT_START) || classify(place, m.duration) !== 'kept') return
    const at = resumeAt(place)
    visit.awaiting = at
    this.deps.port.seek(at)
    this.deps.port.toast(`Resumed at ${formatTime(at)}`, { label: 'Start over', run: () => this.startOver(visit.key) })
  }

  private startOver(key: string): void {
    this.deps.store.save(key, { t: null })
    if (this.visit?.key !== key) return
    this.visit.awaiting = null
    this.deps.port.seek(0)
  }

  private watchPlayhead(visit: Visit, prev: Moment, m: Moment): void {
    if (m.playing) visit.played = true
    if (!visit.long) return
    if (visit.awaiting !== null) {
      const playingOn = prev.playing && m.playing && m.time > prev.time && m.time - prev.time < A_STEP
      if (m.time < visit.awaiting - ARRIVED && !playingOn) return
      visit.awaiting = null
    }
    const stopped = prev.playing && !m.playing
    const due = m.playing && this.deps.port.now() - visit.lastSavedAt >= SAVE_EVERY_MS
    if (stopped || due) this.keep(m.time, m.duration)
  }

  /** Keep where the playhead is as the place of the recording (or forget the place, if it is the beginning or the end). */
  private keep(time: number, duration: number): void {
    const visit = this.visit
    if (!visit || !visit.long || !visit.played || visit.awaiting !== null) return
    const place = classify(time, duration)
    if (place === null) return
    visit.lastSavedAt = this.deps.port.now()
    this.deps.store.save(visit.key, { t: place === 'kept' ? time : null })
  }

  // ---- the speed ----

  /** The speed songs are played at: the one kept on the device, or, when none is kept yet, the speed the player has now (which is then kept). */
  private usualSpeed(playerSpeed: number): number {
    if (this.usual === null) {
      this.usual = this.deps.port.readUsualSpeed()
      if (this.usual === null) {
        this.usual = playerSpeed
        this.deps.port.writeUsualSpeed(playerSpeed)
      }
    }
    return this.usual
  }

  /** Put the player at the speed this track is played at: its own if it is a long recording that has one, the usual speed otherwise. */
  private applySpeed(visit: Visit, m: Moment, record: Progress | null): void {
    const speed = planSpeed({ long: m.long, stored: record?.speed ?? null, usual: this.usualSpeed(m.speed) })
    visit.speed = speed
    if (!sameSpeed(speed, m.speed)) this.deps.port.setSpeed(speed)
  }

  /** A speed that is neither the one the player had a moment ago nor the one the session asked for was chosen by the person. */
  private watchSpeed(visit: Visit, prev: Moment, m: Moment): void {
    if (sameSpeed(m.speed, prev.speed) || sameSpeed(m.speed, visit.speed)) return
    visit.speed = m.speed
    const before = this.usualSpeed(m.speed)
    const { usual, stored } = rememberSpeed({ long: visit.long, speed: m.speed, usual: before })
    if (!sameSpeed(usual, before)) {
      this.usual = usual
      this.deps.port.writeUsualSpeed(usual)
    }
    if (stored !== null) this.deps.store.save(visit.key, { speed: stored })
  }
}
