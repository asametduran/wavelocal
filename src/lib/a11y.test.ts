import { afterEach, describe, expect, it } from 'vitest'
import { Announcer, DialogStack, matchAnnouncement, moveAnnouncement, rovingTarget, spokenPercent, spokenProgress, spokenTime, tabbables, trackAnnouncement, trapTarget } from './a11y'

describe('spokenTime', () => {
  it('speaks hours, minutes and seconds with correct plurals', () => {
    expect(spokenTime(0)).toBe('0 seconds')
    expect(spokenTime(1)).toBe('1 second')
    expect(spokenTime(65)).toBe('1 minute 5 seconds')
    expect(spokenTime(120)).toBe('2 minutes')
    expect(spokenTime(3661)).toBe('1 hour 1 minute 1 second')
    expect(spokenTime(7200)).toBe('2 hours')
  })
  it('floors fractions and survives bad input', () => {
    expect(spokenTime(59.9)).toBe('59 seconds')
    for (const bad of [-1, NaN, Infinity]) expect(spokenTime(bad)).toBe('0 seconds')
  })
})

describe('spokenProgress / spokenPercent', () => {
  it('reads position and length', () => {
    expect(spokenProgress(65, 200)).toBe('1 minute 5 seconds of 3 minutes 20 seconds')
  })
  it('omits the length while it is unknown', () => {
    expect(spokenProgress(5, 0)).toBe('5 seconds')
    expect(spokenProgress(5, NaN)).toBe('5 seconds')
  })
  it('clamps percentages', () => {
    expect(spokenPercent(0.456)).toBe('46 percent')
    expect(spokenPercent(-1)).toBe('0 percent')
    expect(spokenPercent(3)).toBe('100 percent')
  })
})

describe('rovingTarget', () => {
  it('moves along a horizontal group and wraps', () => {
    expect(rovingTarget('ArrowRight', 0, 3)).toBe(1)
    expect(rovingTarget('ArrowRight', 2, 3)).toBe(0)
    expect(rovingTarget('ArrowLeft', 0, 3)).toBe(2)
    expect(rovingTarget('ArrowLeft', 2, 3)).toBe(1)
  })
  it('only honours the arrows of its orientation', () => {
    expect(rovingTarget('ArrowDown', 0, 3, 'horizontal')).toBeNull()
    expect(rovingTarget('ArrowRight', 0, 3, 'vertical')).toBeNull()
    expect(rovingTarget('ArrowDown', 0, 3, 'vertical')).toBe(1)
    expect(rovingTarget('ArrowUp', 0, 3, 'vertical')).toBe(2)
  })
  it('accepts every arrow in a two-dimensional group', () => {
    expect(rovingTarget('ArrowDown', 0, 4, 'both')).toBe(1)
    expect(rovingTarget('ArrowRight', 0, 4, 'both')).toBe(1)
    expect(rovingTarget('ArrowUp', 0, 4, 'both')).toBe(3)
    expect(rovingTarget('ArrowLeft', 0, 4, 'both')).toBe(3)
  })
  it('handles Home / End, other keys and empty groups', () => {
    expect(rovingTarget('Home', 2, 5)).toBe(0)
    expect(rovingTarget('End', 0, 5)).toBe(4)
    expect(rovingTarget('a', 0, 5)).toBeNull()
    expect(rovingTarget('ArrowRight', 0, 0)).toBeNull()
  })
  it('tolerates a stale current index', () => {
    expect(rovingTarget('ArrowRight', 9, 3)).toBe(0)
    expect(rovingTarget('ArrowLeft', -4, 3)).toBe(2)
  })
})

describe('focus trap', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const dialog = (html: string): HTMLElement => {
    document.body.innerHTML = `<button id="outside">outside</button><div id="d" tabindex="-1">${html}</div>`
    return document.getElementById('d') as HTMLElement
  }
  const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement

  it('lists tabbable elements in order and skips disabled, hidden, inert and tabindex=-1 ones', () => {
    const root = dialog(`
      <button id="a">a</button>
      <button id="dis" disabled>x</button>
      <input id="b" />
      <input type="hidden" />
      <button id="neg" tabindex="-1">n</button>
      <div inert><button id="in">i</button></div>
      <div aria-hidden="true"><button id="ah">h</button></div>
      <div hidden><button id="hd">h</button></div>
      <a id="link" href="#x">l</a>
      <div id="tab" tabindex="0">t</div>`)
    expect(tabbables(root).map((e) => e.id)).toEqual(['a', 'b', 'link', 'tab'])
  })

  it('wraps Tab from the last element to the first and Shift+Tab the other way', () => {
    const root = dialog('<button id="a">a</button><button id="b">b</button><button id="c">c</button>')
    expect(trapTarget(root, el('c'), false)).toBe(el('a'))
    expect(trapTarget(root, el('a'), true)).toBe(el('c'))
  })

  it('lets the browser move focus inside the dialog', () => {
    const root = dialog('<button id="a">a</button><button id="b">b</button><button id="c">c</button>')
    expect(trapTarget(root, el('a'), false)).toBeNull()
    expect(trapTarget(root, el('b'), true)).toBeNull()
    expect(trapTarget(root, el('b'), false)).toBeNull()
  })

  it('pulls focus in when it is outside, on the dialog itself or nowhere', () => {
    const root = dialog('<button id="a">a</button><button id="b">b</button>')
    expect(trapTarget(root, el('outside'), false)).toBe(el('a'))
    expect(trapTarget(root, el('outside'), true)).toBe(el('b'))
    expect(trapTarget(root, root, false)).toBe(el('a'))
    expect(trapTarget(root, null, false)).toBe(el('a'))
  })

  it('keeps focus on the dialog when it has nothing focusable', () => {
    const root = dialog('<p>text only</p>')
    expect(trapTarget(root, el('outside'), false)).toBe(root)
  })
})

describe('announcements', () => {
  const track = { title: 'Blue Hour', artist: 'Kestrel' }
  it('announces a new track with its artist', () => {
    expect(trackAnnouncement(track, true, true)).toBe('Now playing: Blue Hour by Kestrel')
    expect(trackAnnouncement(track, false, true)).toBe('Selected: Blue Hour by Kestrel')
  })
  it('leaves out an unknown artist', () => {
    expect(trackAnnouncement({ title: 'Blue Hour', artist: 'Unknown Artist' }, true, true)).toBe('Now playing: Blue Hour')
    expect(trackAnnouncement({ title: 'Blue Hour', artist: '' }, true, true)).toBe('Now playing: Blue Hour')
  })
  it('announces play state changes of the same track', () => {
    expect(trackAnnouncement(track, true, false)).toBe('Playing')
    expect(trackAnnouncement(track, false, false)).toBe('Paused')
  })
  it('is silent without a track', () => {
    expect(trackAnnouncement(null, true, true)).toBe('')
    expect(trackAnnouncement(undefined, false, false)).toBe('')
  })
  it('describes moves and search results', () => {
    expect(moveAnnouncement('Blue Hour', 2, 9)).toBe('Blue Hour moved to position 2 of 9')
    expect(matchAnnouncement(0, 'zzz')).toBe('No tracks match your search')
    expect(matchAnnouncement(1, 'blue')).toBe('1 track matches')
    expect(matchAnnouncement(12, 'blue')).toBe('12 tracks match')
    expect(matchAnnouncement(12, '   ')).toBe('')
  })
})

describe('DialogStack', () => {
  it('only the most recently opened dialog is on top', () => {
    const s = new DialogStack()
    const a = s.push()
    const b = s.push()
    expect(s.isTop(a)).toBe(false)
    expect(s.isTop(b)).toBe(true)
    s.remove(b)
    expect(s.isTop(a)).toBe(true)
  })
  it('removing out of order and twice is safe', () => {
    const s = new DialogStack()
    const a = s.push()
    const b = s.push()
    s.remove(a)
    s.remove(a)
    expect(s.size).toBe(1)
    expect(s.isTop(b)).toBe(true)
    s.remove(b)
    expect(s.size).toBe(0)
    expect(s.isTop(b)).toBe(false)
  })
})

describe('Announcer', () => {
  it('publishes text to subscribers and ignores empty messages', () => {
    const a = new Announcer()
    const seen: string[] = []
    const off = a.subscribe(() => seen.push(a.snapshot().text))
    a.say('Playing')
    a.say('')
    a.say('Paused')
    expect(seen).toEqual(['Playing', 'Paused'])
    off()
    a.say('Playing')
    expect(seen).toHaveLength(2)
  })
  it('makes an immediate repeat look like new content', () => {
    const a = new Announcer()
    a.say('Paused')
    const first = a.snapshot()
    a.say('Paused')
    const second = a.snapshot()
    expect(second.id).toBe(first.id + 1)
    expect(second.text).not.toBe(first.text)
    expect(second.text.trim()).toBe('Paused')
  })
})
