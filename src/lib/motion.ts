/** Reduced-motion preference: follow the operating system or override it inside the app (WebViews often cannot see the OS setting). */

export type MotionPref = 'system' | 'reduce' | 'full'

export const MOTION_PREFS: readonly MotionPref[] = ['system', 'reduce', 'full']
export const MOTION_KEY = 'wl-motion'
/** Class on `<html>` that the stylesheet uses to switch animations and transitions off. */
export const REDUCED_CLASS = 'reduce-motion'

export const isMotionPref = (v: unknown): v is MotionPref => typeof v === 'string' && (MOTION_PREFS as readonly string[]).includes(v)

/** Whether motion should be reduced, given the user's choice and what the system asks for. */
export const resolveReducedMotion = (pref: MotionPref, systemReduces: boolean): boolean => pref === 'reduce' || (pref === 'system' && systemReduces)

/** The part of a MediaQueryList the store uses. */
export interface ChangeSource {
  readonly matches: boolean
  addEventListener(type: 'change', listener: () => void): void
  removeEventListener(type: 'change', listener: () => void): void
}

/** The browser pieces the store needs, injectable for tests. */
export interface MotionEnv {
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  query: ChangeSource | null
  root: HTMLElement | null
}

export function browserMotionEnv(): MotionEnv {
  let storage: MotionEnv['storage'] = null
  try {
    storage = localStorage
  } catch {
    // storage blocked: the choice just lasts for this session
  }
  return {
    storage,
    query: typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null,
    root: typeof document === 'undefined' ? null : document.documentElement,
  }
}

/** Observable preference with a resolved `reduced` flag, mirrored as a class on the root element for CSS. */
export class MotionStore {
  private prefValue: MotionPref
  private reducedValue: boolean
  private readonly listeners = new Set<() => void>()
  private readonly onSystemChange = () => this.refresh()

  constructor(private readonly env: MotionEnv) {
    this.prefValue = this.read()
    this.reducedValue = this.resolve()
    this.apply()
    env.query?.addEventListener('change', this.onSystemChange)
  }

  get pref(): MotionPref {
    return this.prefValue
  }

  get reduced(): boolean {
    return this.reducedValue
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  set(pref: MotionPref): void {
    if (!isMotionPref(pref)) return
    this.prefValue = pref
    try {
      this.env.storage?.setItem(MOTION_KEY, pref)
    } catch {
      // ignore
    }
    this.refresh()
  }

  dispose(): void {
    this.env.query?.removeEventListener('change', this.onSystemChange)
    this.listeners.clear()
  }

  private read(): MotionPref {
    try {
      const v = this.env.storage?.getItem(MOTION_KEY)
      if (isMotionPref(v)) return v
    } catch {
      // storage unavailable
    }
    return 'system'
  }

  private resolve(): boolean {
    return resolveReducedMotion(this.prefValue, this.env.query?.matches ?? false)
  }

  private apply(): void {
    this.env.root?.classList.toggle(REDUCED_CLASS, this.reducedValue)
  }

  private refresh(): void {
    this.reducedValue = this.resolve()
    this.apply()
    this.listeners.forEach((l) => l())
  }
}

let shared: MotionStore | null = null

/** The app-wide store, created on first use so importing this module has no side effects. */
export function motionStore(): MotionStore {
  shared ??= new MotionStore(browserMotionEnv())
  return shared
}
