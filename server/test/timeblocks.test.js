import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLegacyTime,
  convertLegacyItems,
  migrateTripDays,
  buildMapsUrl,
  stripHeadingCodes,
} from '../src/timeblocks.js'

test('parseLegacyTime parses explicit am/pm single times', () => {
  assert.deepEqual(parseLegacyTime('8:00 am'), { timeStart: '08:00', timeEnd: null, timeLabel: null })
  assert.deepEqual(parseLegacyTime('12:30 pm'), { timeStart: '12:30', timeEnd: null, timeLabel: null })
  assert.deepEqual(parseLegacyTime('12:15 am'), { timeStart: '00:15', timeEnd: null, timeLabel: null })
})

test('parseLegacyTime parses ranges with en-dash or hyphen', () => {
  assert.deepEqual(parseLegacyTime('8:05–8:40 am'), { timeStart: '08:05', timeEnd: '08:40', timeLabel: null })
  assert.deepEqual(parseLegacyTime('9:45-11:15 am'), { timeStart: '09:45', timeEnd: '11:15', timeLabel: null })
})

test('parseLegacyTime applies a trailing pm marker to both ends', () => {
  assert.deepEqual(parseLegacyTime('1:30–3:00 pm'), { timeStart: '13:30', timeEnd: '15:00', timeLabel: null })
})

test('parseLegacyTime keeps ambiguous times without markers as written', () => {
  assert.deepEqual(parseLegacyTime('8:05–8:40'), { timeStart: '08:05', timeEnd: '08:40', timeLabel: null })
})

test('parseLegacyTime extends backwards ranges across noon', () => {
  assert.deepEqual(parseLegacyTime('11:55–12:30'), { timeStart: '11:55', timeEnd: '12:30', timeLabel: null })
  assert.deepEqual(parseLegacyTime('9:00–1:30'), { timeStart: '09:00', timeEnd: '13:30', timeLabel: null })
})

test('parseLegacyTime falls back to a label for unparseable input', () => {
  assert.deepEqual(parseLegacyTime('Evening'), { timeStart: null, timeEnd: null, timeLabel: 'Evening' })
  assert.deepEqual(parseLegacyTime(''), { timeStart: null, timeEnd: null, timeLabel: null })
})

test('convertLegacyItems infers pm from chronology across a day', () => {
  const items = [
    { time: '8:00 am', plan: 'Leave hotel', code: 'S1', details: '## S1 — Leave hotel\n\nGo.' },
    { time: '11:55–12:30', plan: 'Lunch', code: 'S2', details: '' },
    { time: '1:15–2:00', plan: 'Museum', code: 'S3', details: '', images: ['img_a'] },
  ]
  const out = convertLegacyItems(items)
  assert.deepEqual(out[0], {
    timeStart: '08:00',
    timeEnd: null,
    timeLabel: null,
    title: 'Leave hotel',
    description: '## Leave hotel\n\nGo.',
    imageIds: [],
  })
  assert.equal(out[1].timeStart, '11:55')
  assert.equal(out[1].timeEnd, '12:30')
  assert.equal(out[2].timeStart, '13:15')
  assert.equal(out[2].timeEnd, '14:00')
  assert.deepEqual(out[2].imageIds, ['img_a'])
})

test('migrateTripDays converts old-format days and is idempotent', () => {
  const trip = {
    days: {
      '2026-07-01': {
        mapsUrl: 'https://maps.example',
        items: [{ time: '8:00 am', plan: 'Go', code: 'S1', details: 'x' }],
      },
    },
  }
  assert.equal(migrateTripDays(trip), true)
  const day = trip.days['2026-07-01']
  assert.equal(day.mapsUrl, 'https://maps.example')
  assert.equal(day.items[0].title, 'Go')
  assert.ok(!('plan' in day.items[0]))
  assert.equal(migrateTripDays(trip), false)
})

test('buildMapsUrl builds a directions link from ordered waypoints', () => {
  const url = buildMapsUrl(['West Yellowstone', 'Fountain Paint Pot', 'Old Faithful'])
  assert.ok(url.startsWith('https://www.google.com/maps/dir/?api=1'))
  assert.ok(url.includes('origin=West%20Yellowstone'))
  assert.ok(url.includes('destination=Old%20Faithful'))
  assert.ok(url.includes('waypoints=Fountain%20Paint%20Pot'))
  assert.equal(buildMapsUrl(['Just one']), '')
  assert.equal(buildMapsUrl([]), '')
})

test('stripHeadingCodes removes S-codes from headings', () => {
  assert.equal(stripHeadingCodes('## S1 — Leave hotel'), '## Leave hotel')
  assert.equal(stripHeadingCodes('## Plain heading'), '## Plain heading')
  assert.equal(stripHeadingCodes('body text — with dash'), 'body text — with dash')
})
