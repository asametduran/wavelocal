import type { ReactNode } from 'react'
import { useRovingKeys } from '../hooks/useA11y'

interface RovingGroupProps {
  role: 'tablist' | 'radiogroup'
  label: string
  className?: string
  children: ReactNode
}

/**
 * Container for tabs or radio buttons with the standard keyboard model: only the selected item is in the Tab order
 * (give it `tabIndex={0}` and the others `-1`), arrow keys / Home / End move focus *and* select, and focus wraps.
 */
export default function RovingGroup({ role, label, className, children }: RovingGroupProps) {
  const onKeyDown = useRovingKeys({ items: role === 'tablist' ? '[role="tab"]' : '[role="radio"]', activate: true })
  return (
    <div role={role} aria-label={label} className={className} onKeyDown={onKeyDown}>
      {children}
    </div>
  )
}
