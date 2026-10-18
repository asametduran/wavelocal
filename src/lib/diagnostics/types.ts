/**
 * What the error log keeps. The kinds are a closed set, so that an entry says where a failure came from without any free text, and
 * everything else in an entry is bounded (see `redact.ts` and `log.ts`).
 */
export const LOG_KINDS = ['error', 'rejection', 'boundary', 'save', 'decode', 'worker', 'play', 'library', 'shell'] as const

export type LogKind = (typeof LOG_KINDS)[number]

export interface LogEntry {
  /** When it last happened, in milliseconds since 1970. */
  readonly at: number
  readonly kind: LogKind
  /** The error's name (`QuotaExceededError`, `TypeError`): code, never data. */
  readonly name: string
  /** What the error said, with names, paths, links and quoted text taken out. */
  readonly message: string
  /** Where in the app's code it happened: `function (file.js:line:column)`, never a link. */
  readonly frames: readonly string[]
  /** How many times in a row it happened (the same failure repeating is one entry). */
  readonly count: number
}

/** An error as the log keeps it, before it has a time and a count. */
export interface DescribedError {
  readonly name: string
  readonly message: string
  readonly frames: readonly string[]
}
