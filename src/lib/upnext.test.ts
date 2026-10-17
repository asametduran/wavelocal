import { describe, expect, it } from 'vitest'
import { MAX_UP_NEXT, continueAfter, dequeueAt, keepKnown, moveQueued, nextQueued, queueLast, queueNext, requeueAt, resumeAfterQueued, takeQueued, unqueue } from './upnext'

describe('queueNext', () => {
  it('puts the tracks ahead of everything already queued, in the order given', () => {
    expect(queueNext(['a', 'b'], ['x', 'y'])).toEqual(['x', 'y', 'a', 'b'])
  })

  it('puts the latest "play next" first, the way a music app does', () => {
    const afterFirst = queueNext([], ['one'])
    expect(queueNext(afterFirst, ['two'])).toEqual(['two', 'one'])
  })

  it('does nothing, and hands back the very same queue, for no tracks', () => {
    const queue = ['a']
    expect(queueNext(queue, [])).toBe(queue)
  })

  it('does not change the queue it is given', () => {
    const queue = Object.freeze(['a'])
    expect(queueNext(queue, ['x'])).toEqual(['x', 'a'])
    expect(queue).toEqual(['a'])
  })

  it('never grows past the limit, keeping what will play first', () => {
    const full = Array.from({ length: MAX_UP_NEXT }, (_, i) => `t${i}`)
    const next = queueNext(full, ['new'])
    expect(next).toHaveLength(MAX_UP_NEXT)
    expect(next[0]).toBe('new')
    expect(next.at(-1)).toBe(`t${MAX_UP_NEXT - 2}`)
  })
})

describe('queueLast', () => {
  it('adds the tracks after everything already queued', () => {
    expect(queueLast(['a', 'b'], ['x', 'y'])).toEqual(['a', 'b', 'x', 'y'])
  })

  it('lets a track be queued more than once', () => {
    expect(queueLast(['a'], ['a'])).toEqual(['a', 'a'])
  })

  it('does nothing, and hands back the very same queue, for no tracks', () => {
    const queue = ['a']
    expect(queueLast(queue, [])).toBe(queue)
  })

  it('stops adding at the limit and hands back the same queue when it is full', () => {
    const full = Array.from({ length: MAX_UP_NEXT }, (_, i) => `t${i}`)
    expect(queueLast(full, ['x'])).toBe(full)
    const almost = full.slice(0, MAX_UP_NEXT - 1)
    expect(queueLast(almost, ['x', 'y'])).toEqual([...almost, 'x'])
  })
})

describe('dequeueAt', () => {
  it('takes one track out', () => {
    expect(dequeueAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
  })

  it('leaves the queue alone for a position that is not in it', () => {
    const queue = ['a', 'b']
    expect(dequeueAt(queue, -1)).toBe(queue)
    expect(dequeueAt(queue, 2)).toBe(queue)
    expect(dequeueAt(queue, 1.5)).toBe(queue)
  })
})

describe('requeueAt', () => {
  it('puts a track back at the place it was taken from', () => {
    expect(requeueAt(['a', 'c'], 1, 'b')).toEqual(['a', 'b', 'c'])
    expect(requeueAt(['b', 'c'], 0, 'a')).toEqual(['a', 'b', 'c'])
  })

  it('puts it last when the queue has become shorter than the place it was taken from', () => {
    expect(requeueAt(['a'], 5, 'z')).toEqual(['a', 'z'])
  })

  it('puts it first for a place before the front, and last for a place that makes no sense', () => {
    expect(requeueAt(['a'], -3, 'z')).toEqual(['z', 'a'])
    expect(requeueAt(['a'], Number.NaN, 'z')).toEqual(['a', 'z'])
    expect(requeueAt(['a'], 0.5, 'z')).toEqual(['a', 'z'])
  })

  it('does not grow a full queue', () => {
    const full = Array.from({ length: MAX_UP_NEXT }, (_, i) => `t${i}`)
    expect(requeueAt(full, 0, 'z')).toBe(full)
  })

  it('does not change the queue it is given', () => {
    const queue = Object.freeze(['a', 'c'])
    expect(requeueAt(queue, 1, 'b')).toEqual(['a', 'b', 'c'])
    expect(queue).toEqual(['a', 'c'])
  })
})

describe('unqueue', () => {
  it('takes one occurrence of each track out, starting from the front', () => {
    expect(unqueue(['a', 'b', 'a', 'c'], ['a'], 'front')).toEqual(['b', 'a', 'c'])
    expect(unqueue(['a', 'b', 'a', 'c'], ['a', 'c'], 'front')).toEqual(['b', 'a'])
  })

  it('or starting from the back', () => {
    expect(unqueue(['a', 'b', 'a', 'c'], ['a'], 'back')).toEqual(['a', 'b', 'c'])
  })

  it('takes out as many occurrences as it is given ids', () => {
    expect(unqueue(['a', 'a', 'a'], ['a', 'a'], 'back')).toEqual(['a'])
  })

  it('ignores tracks that are not queued, and hands back the very same queue when nothing changed', () => {
    const queue = ['a', 'b']
    expect(unqueue(queue, ['z'], 'front')).toBe(queue)
    expect(unqueue(queue, [], 'back')).toBe(queue)
    expect(unqueue(queue, ['b', 'z'], 'front')).toEqual(['a'])
  })

  it('does not change the queue it is given', () => {
    const queue = Object.freeze(['a', 'b'])
    unqueue(queue, ['a'], 'front')
    expect(queue).toEqual(['a', 'b'])
  })
})

describe('moveQueued', () => {
  it('moves a track to a new position', () => {
    expect(moveQueued(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveQueued(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })

  it('leaves the queue alone for moves that go nowhere or off the ends', () => {
    const queue = ['a', 'b', 'c']
    expect(moveQueued(queue, 1, 1)).toBe(queue)
    expect(moveQueued(queue, -1, 1)).toBe(queue)
    expect(moveQueued(queue, 0, 3)).toBe(queue)
  })
})

describe('keepKnown', () => {
  const known = (id: string): boolean => id.startsWith('t')

  it('keeps the tracks the library still has, in order', () => {
    expect(keepKnown(['t1', 'gone', 't2', 't1'], known)).toEqual(['t1', 't2', 't1'])
  })

  it('reads whatever was stored as untrusted: only a list of text counts', () => {
    expect(keepKnown(['t1', 7, null, { id: 't2' }, 't3'], known)).toEqual(['t1', 't3'])
    for (const raw of [null, undefined, 'abc', 5, {}, { length: 2, 0: 't1' }]) expect(keepKnown(raw, known)).toEqual([])
  })

  it('keeps no more than the limit', () => {
    const many = Array.from({ length: MAX_UP_NEXT + 25 }, (_, i) => `t${i}`)
    expect(keepKnown(many, known)).toHaveLength(MAX_UP_NEXT)
  })
})

describe('continueAfter', () => {
  it('is the track that is playing when it came from the list', () => {
    expect(continueAfter(null, 'a')).toBe('a')
  })

  it('is the track that was playing when the queue took over, for as long as a queued track plays', () => {
    expect(continueAfter({ forId: 'q', anchor: 'a' }, 'q')).toBe('a')
  })

  it('is the track that is playing when it is another one (the listener went somewhere else)', () => {
    expect(continueAfter({ forId: 'q', anchor: 'a' }, 'z')).toBe('z')
  })

  it('is nothing when nothing is playing', () => {
    expect(continueAfter(null, null)).toBeNull()
  })
})

describe('resumeAfterQueued', () => {
  it('remembers the track that was playing, for the queued track that is about to start', () => {
    expect(resumeAfterQueued(null, 'a', 'q')).toEqual({ forId: 'q', anchor: 'a' })
  })

  it('keeps the first track across queued tracks that follow each other', () => {
    const first = resumeAfterQueued(null, 'a', 'q')
    expect(resumeAfterQueued(first, 'q', 'r')).toEqual({ forId: 'r', anchor: 'a' })
  })

  it('starts over from the track that plays when the listener had gone somewhere else meanwhile', () => {
    expect(resumeAfterQueued({ forId: 'q', anchor: 'a' }, 'x', 'r')).toEqual({ forId: 'r', anchor: 'x' })
  })

  it('has nothing to remember when nothing was playing', () => {
    expect(resumeAfterQueued(null, null, 'q')).toBeNull()
  })
})

describe('nextQueued', () => {
  const library = new Map(['t1', 't2', 't3'].map((id) => [id, { id, title: id }]))
  const find = (id: string) => library.get(id)

  it('is the first queued track and what is left after it', () => {
    const next = nextQueued(['t2', 't3'], find)
    expect(next?.track.id).toBe('t2')
    expect(next?.rest).toEqual(['t3'])
  })

  it('skips tracks the library no longer has, dropping them from what is left', () => {
    const next = nextQueued(['gone', 'also-gone', 't3', 't1'], find)
    expect(next?.track.id).toBe('t3')
    expect(next?.rest).toEqual(['t1'])
  })

  it('is nothing for an empty queue or one that holds only missing tracks', () => {
    expect(nextQueued([], find)).toBeNull()
    expect(nextQueued(['gone'], find)).toBeNull()
  })

  it('does not change the queue it is given', () => {
    const queue = Object.freeze(['t1', 't2'])
    nextQueued(queue, find)
    expect(queue).toEqual(['t1', 't2'])
  })
})

describe('takeQueued', () => {
  const library = new Map(['t1', 't2', 't3'].map((id) => [id, { id, title: id }]))
  const find = (id: string) => library.get(id)

  it('takes the first queued track, leaves the rest, and has the list carry on after the track it interrupts', () => {
    const taken = takeQueued(['t2', 't3'], null, 'a', find)
    expect(taken?.track.id).toBe('t2')
    expect(taken?.queue).toEqual(['t3'])
    expect(taken?.resume).toEqual({ forId: 't2', anchor: 'a' })
  })

  it('keeps the first interrupted track as the place to carry on from, across queued tracks that follow each other', () => {
    const first = takeQueued(['t1', 't2'], null, 'a', find)
    const second = first && takeQueued(first.queue, first.resume, 't1', find)
    expect(second?.track.id).toBe('t2')
    expect(second?.resume).toEqual({ forId: 't2', anchor: 'a' })
  })

  it('skips the tracks the library no longer has, and drops them from what is left', () => {
    const taken = takeQueued(['gone', 't3', 'also-gone', 't1'], null, 'a', find)
    expect(taken?.track.id).toBe('t3')
    expect(taken?.queue).toEqual(['also-gone', 't1'])
  })

  it('has nothing to carry on after when nothing was playing, but still takes the track', () => {
    const taken = takeQueued(['t1'], null, null, find)
    expect(taken?.track.id).toBe('t1')
    expect(taken?.resume).toBeNull()
  })

  it('is nothing for an empty queue or one that holds only missing tracks', () => {
    expect(takeQueued([], null, 'a', find)).toBeNull()
    expect(takeQueued(['gone'], null, 'a', find)).toBeNull()
  })

  it('changes neither the queue nor the resume point it is given', () => {
    const queue = Object.freeze(['t1', 't2'])
    const resume = Object.freeze({ forId: 'x', anchor: 'a' })
    takeQueued(queue, resume, 'x', find)
    expect(queue).toEqual(['t1', 't2'])
    expect(resume).toEqual({ forId: 'x', anchor: 'a' })
  })
})
