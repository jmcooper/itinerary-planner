// Time-block helpers: 12-hour display formatting, lenient time input parsing,
// and conversion of CSV-import rows to the time-block item shape. The parsing
// logic mirrors server/src/timeblocks.js.
import { stripCodeFromHeadings } from './parse.js'

const TOKEN_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i
const HALF_DAY = 12 * 60

function parseToken(raw) {
  const m = (raw ?? '').trim().match(TOKEN_RE)
  if (!m) return null
  let hour = Number(m[1])
  const minute = Number(m[2] ?? 0)
  if (hour > 23 || minute > 59) return null
  const meridiem = m[3] ? (m[3].toLowerCase().startsWith('p') ? 'pm' : 'am') : null
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  return { minutes: hour * 60 + minute, meridiem }
}

function toHHMM(minutes) {
  const h = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

function parseLegacyTime(str) {
  const trimmed = (str ?? '').trim()
  const label = { timeStart: null, timeEnd: null, timeLabel: trimmed || null }
  const parts = trimmed.split(/[–—-]/).map((p) => p.trim()).filter(Boolean)
  if (parts.length === 1) {
    const t = parseToken(parts[0])
    return t ? { timeStart: toHHMM(t.minutes), timeEnd: null, timeLabel: null } : label
  }
  if (parts.length === 2) {
    const a = parseToken(parts[0])
    const b = parseToken(parts[1])
    if (!a || !b) return label
    let start = a.minutes
    let end = b.minutes
    if (!a.meridiem && b.meridiem === 'pm' && start < HALF_DAY && start + HALF_DAY <= end) {
      start += HALF_DAY
    }
    if (end < start && !b.meridiem && end + HALF_DAY >= start) end += HALF_DAY
    if (end < start) return label
    return { timeStart: toHHMM(start), timeEnd: toHHMM(end), timeLabel: null }
  }
  return label
}

function fmt12(hhmm) {
  let h = Number(hhmm.slice(0, 2))
  const m = hhmm.slice(3)
  const mer = h >= 12 ? 'pm' : 'am'
  h = h % 12 || 12
  return { text: `${h}:${m}`, mer }
}

// Display string for a time-block item: the raw label when times couldn't be
// parsed, otherwise a compact 12-hour time or range.
export function formatTimeBlock(item) {
  if (item.timeLabel) return item.timeLabel
  if (!item.timeStart) return ''
  const a = fmt12(item.timeStart)
  if (!item.timeEnd) return `${a.text} ${a.mer}`
  const b = fmt12(item.timeEnd)
  if (a.mer === b.mer) return `${a.text} – ${b.text} ${b.mer}`
  return `${a.text} ${a.mer} – ${b.text} ${b.mer}`
}

// Lenient user input ("8:15 am", "14:00") -> "HH:MM" or null.
export function parseTimeInput(str) {
  const t = parseToken(str)
  return t ? toHHMM(t.minutes) : null
}

// "15 min", "1 hr", "1 hr 20 min" between timeStart and timeEnd, or ''.
export function formatDuration(item) {
  if (!item.timeStart || !item.timeEnd) return ''
  const span = toMinutes(item.timeEnd) - toMinutes(item.timeStart)
  if (span <= 0) return ''
  const hours = Math.floor(span / 60)
  const minutes = span % 60
  if (!hours) return `${minutes} min`
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`
}

// Converts CSV-import rows ({time, plan, details}) to time-block items with
// chronological pm inference across the day.
export function convertImportItems(items) {
  let cursor = 0
  return (items ?? []).map((item) => {
    const parsed = parseLegacyTime(item.time)
    let { timeStart, timeEnd } = parsed
    const hasMarker = /am|pm|a\.m\.|p\.m\./i.test(item.time ?? '')
    if (timeStart && !hasMarker) {
      let start = toMinutes(timeStart)
      let end = timeEnd ? toMinutes(timeEnd) : null
      if (start < cursor && start < HALF_DAY && start + HALF_DAY >= cursor) {
        start += HALF_DAY
        if (end !== null && end < start) end += HALF_DAY
        timeStart = toHHMM(start)
        if (end !== null) timeEnd = toHHMM(end)
      }
    }
    if (timeEnd) cursor = Math.max(cursor, toMinutes(timeEnd))
    else if (timeStart) cursor = Math.max(cursor, toMinutes(timeStart))
    return {
      timeStart,
      timeEnd,
      timeLabel: parsed.timeLabel,
      title: item.plan ?? '',
      description: stripCodeFromHeadings(item.details ?? ''),
      travel: false,
      imageIds: [],
    }
  })
}
