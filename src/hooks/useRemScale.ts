import { useEffect, useState } from 'react'

/** The page's root font size in units of the usual 16 px: 1 normally, 1.5 in TV mode, more when the reader asked for bigger text. */
function readScale(): number {
  if (typeof document === 'undefined') return 1
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(px) && px > 0 ? px / 16 : 1
}

/**
 * Virtualized lists need row heights in pixels, but the text inside them is sized in rem: when the root font grows (TV
 * mode, large text) the rows must grow with it or their content overflows. Multiply fixed pixel sizes by this.
 */
export function useRemScale(): number {
  const [scale, setScale] = useState(readScale)
  useEffect(() => {
    const update = () => setScale(readScale())
    update()
    window.addEventListener('resize', update)
    // TV mode changes the root font size by switching a class on <html>
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    return () => {
      window.removeEventListener('resize', update)
      observer.disconnect()
    }
  }, [])
  return scale
}
