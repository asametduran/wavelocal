/** Why a file was not saved, in terms a person can act on. */
export type SaveFailure =
  /** The device has no room left. */
  | 'full'
  /** A save of this app is already open (its share sheet has not come back). */
  | 'busy'
  /** This build cannot save a file here: the native part could not be reached. */
  | 'unavailable'
  /** Anything else; the details are in the error log. */
  | 'other'

/** What came of asking to save a file. `saveFile` always answers with one of these and never throws. */
export type SaveOutcome =
  /** A download was started: the browser or the desktop shell takes it from here, and nothing says where it goes. */
  | { readonly kind: 'downloaded' }
  /** Android: the file was handed to the system share sheet, and the person chose where it goes. */
  | { readonly kind: 'shared' }
  /** Android: the share sheet was closed without a choice. Nothing was kept. */
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly why: SaveFailure; readonly error: unknown }
