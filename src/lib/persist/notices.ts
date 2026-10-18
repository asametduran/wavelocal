import { confirmDialog, noticeDialog, toast } from '../overlays'
import { describeSaveFailure } from '../storage'
import type { GateMode, MemoryReason } from './gate'

/**
 * What a person is told when their window is not saving. A lazy chunk: it is only fetched when there is something to say. A window
 * that is not saving must never look as if it were, so each way of not saving has its own words, and none is a surprise later.
 */

export interface NoticePorts {
  reload: () => void
  /** Try every failing save again now. */
  retryNow: () => void
}

const defaults: NoticePorts = {
  reload: () => location.reload(),
  retryNow: () => void import('./failures').then((failures) => failures.retryNow()).catch(() => {}),
}

/** Saves started failing, or the last failing one went through. Told once for each, so a disk that stays full does not become a pile of toasts. */
export function explainFailing(event: 'failing' | 'recovered', error: unknown, ports: Pick<NoticePorts, 'retryNow'> = defaults): void {
  if (event === 'recovered') {
    toast('Saving works again.')
    return
  }
  toast(describeSaveFailure(error, 'Your latest changes could not be saved on this device. Wavelocal keeps trying.'), { action: { label: 'Try again', run: ports.retryNow } })
}

/** Explain why changes in this window are not being saved. Resolves when the person has answered. */
export async function explainDropped(mode: GateMode, reason: MemoryReason | null, ports: Pick<NoticePorts, 'reload'> = defaults): Promise<void> {
  if (mode === 'memory' && reason === 'unavailable') {
    await noticeDialog({
      title: 'Nothing can be saved here',
      message: 'This browser does not let Wavelocal keep anything on this device. Your library is gone when this tab closes.',
    })
    return
  }
  if (mode === 'taken') {
    // taking over is a reload: the window that starts claims the library from the one that has it
    const take = await confirmDialog({
      title: 'Another window took over',
      message: 'Another window of Wavelocal has taken over your library. Changes made here are not saved. Use this window instead? It reloads, and any other window stops saving.',
      confirmLabel: 'Use this window',
      cancelLabel: 'Not now',
    })
    if (take) ports.reload()
    return
  }
  if (mode === 'memory') {
    const reload = await confirmDialog({
      title: 'Wavelocal is not saving',
      message: 'Wavelocal could not open the library saved on this device, so it is not saving anything in this window, to protect what is there. Your files are untouched. Reload to try again.',
      confirmLabel: 'Reload',
      cancelLabel: 'Not now',
    })
    if (reload) ports.reload()
  }
}
