import { describe, expect, it } from 'vitest'
import { parseOsc7Cwd, tabLabel } from '../src/client/labels.ts'

describe('tabLabel', () => {
  it('uses the last path segment', () => {
    expect(tabLabel('/home/dev/myproj', 'Terminal')).toBe('myproj')
  })

  it('ignores trailing slashes', () => {
    expect(tabLabel('/home/dev/myproj/', 'Terminal')).toBe('myproj')
    expect(tabLabel('/home/dev/myproj///', 'Terminal')).toBe('myproj')
  })

  it('keeps the root path intact', () => {
    expect(tabLabel('/', 'Terminal')).toBe('/')
  })

  it('falls back when the directory is unknown', () => {
    expect(tabLabel('', 'Terminal')).toBe('Terminal')
  })

  it('keeps slash-free input as-is', () => {
    expect(tabLabel('myproj', 'Terminal')).toBe('myproj')
  })
})

describe('parseOsc7Cwd', () => {
  it('extracts the path after the host segment', () => {
    expect(parseOsc7Cwd('file://host/home/dev/myproj')).toBe('/home/dev/myproj')
  })

  it('accepts an empty host', () => {
    expect(parseOsc7Cwd('file:///home/dev')).toBe('/home/dev')
  })

  it('decodes percent-encoded paths', () => {
    expect(parseOsc7Cwd('file://host/home/dev/my%20proj')).toBe('/home/dev/my proj')
    expect(parseOsc7Cwd('file://host/home/dev/%E4%B8%AD%E6%96%87')).toBe('/home/dev/中文')
  })

  it('keeps the raw path when decoding fails', () => {
    expect(parseOsc7Cwd('file://host/a%zz')).toBe('/a%zz')
  })

  it('returns undefined for foreign prefixes and host-only payloads', () => {
    expect(parseOsc7Cwd('http://host/path')).toBeUndefined()
    expect(parseOsc7Cwd('file://host')).toBeUndefined()
    expect(parseOsc7Cwd('')).toBeUndefined()
  })
})
