import { describe, it, expect } from 'vitest'
import {
  formatTimeBlock,
  parseTimeInput,
  convertImportItems,
  formatDuration,
  insertItemByTime,
} from './time.js'

describe('formatDuration', () => {
  it('formats the span between timeStart and timeEnd', () => {
    expect(formatDuration({ timeStart: '12:30', timeEnd: '12:45' })).toBe('15 min')
    expect(formatDuration({ timeStart: '09:00', timeEnd: '10:00' })).toBe('1 hr')
    expect(formatDuration({ timeStart: '09:00', timeEnd: '10:20' })).toBe('1 hr 20 min')
  })
  it('returns empty when times are missing or reversed', () => {
    expect(formatDuration({ timeStart: '09:00', timeEnd: null })).toBe('')
    expect(formatDuration({ timeStart: null, timeEnd: null })).toBe('')
    expect(formatDuration({ timeStart: '10:00', timeEnd: '09:00' })).toBe('')
  })
})

describe('formatTimeBlock', () => {
  it('formats ranges in 12-hour style', () => {
    expect(formatTimeBlock({ timeStart: '08:15', timeEnd: '08:45' })).toBe('8:15 – 8:45 am')
    expect(formatTimeBlock({ timeStart: '11:30', timeEnd: '13:00' })).toBe('11:30 am – 1:00 pm')
  })
  it('formats single times and labels', () => {
    expect(formatTimeBlock({ timeStart: '20:00', timeEnd: null })).toBe('8:00 pm')
    expect(formatTimeBlock({ timeStart: null, timeEnd: null, timeLabel: 'Evening' })).toBe('Evening')
    expect(formatTimeBlock({ timeStart: null, timeEnd: null, timeLabel: null })).toBe('')
  })
})

describe('parseTimeInput', () => {
  it('accepts 12h and 24h input', () => {
    expect(parseTimeInput('8:15 am')).toBe('08:15')
    expect(parseTimeInput('1:05 pm')).toBe('13:05')
    expect(parseTimeInput('14:00')).toBe('14:00')
    expect(parseTimeInput('12:00 am')).toBe('00:00')
    expect(parseTimeInput('')).toBe(null)
    expect(parseTimeInput('bogus')).toBe(null)
  })
})

describe('convertImportItems', () => {
  it('converts CSV-import items with chronological pm inference', () => {
    const out = convertImportItems([
      { time: '8:00 am', plan: 'Leave hotel', details: '## S1 — Leave hotel\n\nGo.' },
      { time: '1:15–2:00', plan: 'Museum', details: '' },
    ])
    expect(out[0]).toMatchObject({
      timeStart: '08:00',
      timeEnd: null,
      timeLabel: null,
      title: 'Leave hotel',
      imageIds: [],
    })
    expect(out[0].description).toContain('## Leave hotel')
    expect(out[1].timeStart).toBe('13:15')
    expect(out[1].timeEnd).toBe('14:00')
  })
  it('keeps unparseable times as labels', () => {
    const out = convertImportItems([{ time: 'Evening', plan: 'Stroll', details: '' }])
    expect(out[0]).toMatchObject({ timeStart: null, timeEnd: null, timeLabel: 'Evening' })
  })
})

describe('insertItemByTime', () => {
  const t = (timeStart, title) => ({ timeStart, timeEnd: null, title })
  const items = [t('08:00', 'a'), t(null, 'note'), t('10:00', 'b')]

  it('inserts a timed item chronologically', () => {
    const out = insertItemByTime(items, t('09:00', 'new'))
    expect(out.map((i) => i.title)).toEqual(['a', 'note', 'new', 'b'])
  })
  it('appends when the new item is latest', () => {
    const out = insertItemByTime(items, t('11:00', 'new'))
    expect(out.map((i) => i.title)).toEqual(['a', 'note', 'b', 'new'])
  })
  it('inserts before the first item when earliest', () => {
    const out = insertItemByTime(items, t('07:00', 'new'))
    expect(out.map((i) => i.title)).toEqual(['new', 'a', 'note', 'b'])
  })
  it('appends untimed items', () => {
    const out = insertItemByTime(items, t(null, 'new'))
    expect(out.map((i) => i.title)).toEqual(['a', 'note', 'b', 'new'])
  })
  it('does not mutate the original array', () => {
    insertItemByTime(items, t('09:00', 'new'))
    expect(items).toHaveLength(3)
  })
})
