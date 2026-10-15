import { describe, expect, it } from 'vitest'
import { getDesktopBridge } from './desktop-bridge'

const valid = { isDesktop: true, platform: 'win32', versions: { app: '1.0.0', electron: '39.0.0', chrome: '142.0.0.0' } }

describe('getDesktopBridge', () => {
  it('is null in an ordinary browser (nothing on window)', () => {
    expect(getDesktopBridge({})).toBeNull()
    expect(getDesktopBridge(undefined)).toBeNull()
  })

  it('returns a copy of a valid bridge', () => {
    const bridge = getDesktopBridge({ wavelocalDesktop: valid })
    expect(bridge).toEqual(valid)
    expect(bridge).not.toBe(valid)
    expect(bridge?.versions).not.toBe(valid.versions)
  })

  it('ignores anything extra on the object', () => {
    const bridge = getDesktopBridge({ wavelocalDesktop: { ...valid, superpower: () => 'root', versions: { ...valid.versions, node: '24' } } })
    expect(bridge).toEqual(valid)
  })

  it.each([
    ['a string', 'desktop'],
    ['a number', 1],
    ['null', null],
    ['true', true],
    ['missing isDesktop', { ...valid, isDesktop: undefined }],
    ['isDesktop as a string', { ...valid, isDesktop: 'true' }],
    ['isDesktop false', { ...valid, isDesktop: false }],
    ['no platform', { ...valid, platform: '' }],
    ['numeric platform', { ...valid, platform: 7 }],
    ['no versions', { isDesktop: true, platform: 'linux' }],
    ['null versions', { ...valid, versions: null }],
    ['a missing version field', { ...valid, versions: { app: '1', electron: '2' } }],
    ['an empty version', { ...valid, versions: { ...valid.versions, chrome: '' } }],
  ])('rejects %s', (_name, value) => {
    expect(getDesktopBridge({ wavelocalDesktop: value })).toBeNull()
  })

  it('works for every platform string the shell can report', () => {
    for (const platform of ['win32', 'darwin', 'linux']) expect(getDesktopBridge({ wavelocalDesktop: { ...valid, platform } })?.platform).toBe(platform)
  })
})
