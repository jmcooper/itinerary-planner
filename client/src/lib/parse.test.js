import { describe, it, expect } from 'vitest'
import { parseCsv, parseDetails, buildDayItems, stripCodeFromHeadings } from './parse.js'

const SAMPLE_CSV = `Time,Plan,Detail
8:00 am,Leave Holiday Inn West Yellowstone,S1
8:05–8:40,Enter park and drive to Madison Junction,S2
8:50–9:35,Fountain Paint Pot,S3
`

const SAMPLE_DETAILS = `## S1 — Leave Holiday Inn West Yellowstone

Leave at **8:00 am** from Holiday Inn West Yellowstone, 315 Yellowstone Ave.

---

## S2 — Enter park and drive to Madison Junction

You’ll enter through the **West Entrance**.

---

## S3 — Fountain Paint Pot

Easy boardwalk, about 0.5 miles.
`

describe('parseCsv', () => {
  it('parses rows and skips the header', () => {
    const { rows, skipped } = parseCsv(SAMPLE_CSV)
    expect(skipped).toBe(0)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ time: '8:00 am', plan: 'Leave Holiday Inn West Yellowstone', code: 'S1' })
    expect(rows[2].code).toBe('S3')
  })

  it('handles quoted fields containing commas', () => {
    const { rows } = parseCsv('Time,Plan,Detail\n9:00,"Lunch, snacks, and gas",S1')
    expect(rows[0].plan).toBe('Lunch, snacks, and gas')
  })

  it('works without a header row', () => {
    const { rows } = parseCsv('8:00 am,Leave hotel,S1')
    expect(rows).toHaveLength(1)
    expect(rows[0].code).toBe('S1')
  })

  it('counts and skips malformed rows', () => {
    const { rows, skipped } = parseCsv('Time,Plan,Detail\njustonefield\n8:00,Go,S1')
    expect(rows).toHaveLength(1)
    expect(skipped).toBe(1)
  })

  it('tolerates rows without a detail code', () => {
    const { rows } = parseCsv('8:00,Breakfast\n9:00,Drive,S2')
    expect(rows[0]).toEqual({ time: '8:00', plan: 'Breakfast', code: '' })
    expect(rows[1].code).toBe('S2')
  })
})

describe('parseDetails', () => {
  it('splits sections on --- and extracts codes', () => {
    const sections = parseDetails(SAMPLE_DETAILS)
    expect(sections).toHaveLength(3)
    expect(sections.map((s) => s.code)).toEqual(['S1', 'S2', 'S3'])
    expect(sections[0].title).toBe('Leave Holiday Inn West Yellowstone')
    expect(sections[0].markdown).toContain('315 Yellowstone Ave')
  })

  it('accepts hyphen and en-dash separators in headings', () => {
    const sections = parseDetails('## S1 - First stop\n\nBody one.\n\n---\n\n## S2 – Second stop\n\nBody two.')
    expect(sections.map((s) => s.code)).toEqual(['S1', 'S2'])
    expect(sections[1].title).toBe('Second stop')
  })

  it('keeps sections without a recognizable code, with empty code', () => {
    const sections = parseDetails('## Just a heading\n\nText.')
    expect(sections).toHaveLength(1)
    expect(sections[0].code).toBe('')
    expect(sections[0].title).toBe('Just a heading')
  })

  it('ignores --- inside a section only when it is a standalone line', () => {
    const sections = parseDetails('## S1 — A\n\nfoo --- bar\n\n---\n\n## S2 — B\n\nbaz')
    expect(sections).toHaveLength(2)
    expect(sections[0].markdown).toContain('foo --- bar')
  })
})

describe('buildDayItems', () => {
  it('matches CSV rows to detail sections by code', () => {
    const { items, warnings } = buildDayItems(SAMPLE_CSV, SAMPLE_DETAILS)
    expect(items).toHaveLength(3)
    expect(items[0].plan).toBe('Leave Holiday Inn West Yellowstone')
    expect(items[0].details).toContain('315 Yellowstone Ave')
    expect(warnings).toEqual([])
  })

  it('warns about unmatched CSV rows and appends unmatched sections', () => {
    const csv = 'Time,Plan,Detail\n8:00,Go,S1\n9:00,Stop,S9'
    const details = '## S1 — Go\n\nDetails for go.\n\n---\n\n## S7 — Orphan\n\nOrphan details.'
    const { items, warnings } = buildDayItems(csv, details)
    expect(items).toHaveLength(3)
    expect(items[1].details).toBe('')
    expect(items[2]).toMatchObject({ time: '', plan: 'Orphan', code: 'S7' })
    expect(warnings.length).toBe(2)
  })
})

describe('stripCodeFromHeadings', () => {
  it('removes the code prefix from headings for display', () => {
    expect(stripCodeFromHeadings('## S1 — Leave hotel\n\nBody.')).toBe('## Leave hotel\n\nBody.')
  })

  it('leaves plain headings alone', () => {
    expect(stripCodeFromHeadings('## Leave hotel\n\nBody.')).toBe('## Leave hotel\n\nBody.')
  })
})
