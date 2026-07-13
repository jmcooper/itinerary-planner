// Utilities for the time-block day format: legacy time parsing, day migration,
// and deterministic Google Maps directions links.

const HEADING_CODE_RE = /^(#{1,6})\s*[A-Za-z][A-Za-z0-9]*\s*[—–-]\s+(.*)$/

export function stripHeadingCodes(markdown) {
  return (markdown ?? '')
    .split('\n')
    .map((line) => {
      const m = line.match(HEADING_CODE_RE)
      return m ? `${m[1]} ${m[2]}` : line
    })
    .join('\n')
}

const TOKEN_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i

// -> { minutes, meridiem: 'am'|'pm'|null } or null when unparseable.
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

const HALF_DAY = 12 * 60

function toHHMM(minutes) {
  const h = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// Parses legacy time strings like "8:00 am", "8:05–8:40", "9:45-11:15 am",
// "1:30–3:00 pm". A meridiem on the end of a range applies to the start when
// that keeps the range forward. Unparseable input becomes a timeLabel.
export function parseLegacyTime(str) {
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
    // "1:30–3:00 pm": trailing pm applies to the start too when it keeps order.
    if (!a.meridiem && b.meridiem === 'pm' && start < HALF_DAY && start + HALF_DAY <= end) {
      start += HALF_DAY
    }
    // "9:00–1:30": a markerless end earlier than the start crosses noon.
    if (end < start && !b.meridiem && end + HALF_DAY >= start) end += HALF_DAY
    if (end < start) return label
    return { timeStart: toHHMM(start), timeEnd: toHHMM(end), timeLabel: null }
  }
  return label
}

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

// Converts a day's legacy items ({time, plan, code, details, images}) to time
// blocks, inferring pm for markerless times that would otherwise run backwards
// relative to the latest time seen so far in the day.
export function convertLegacyItems(items) {
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
      description: stripHeadingCodes(item.details ?? ''),
      imageIds: item.images ?? [],
    }
  })
}

function isLegacyItem(item) {
  return item != null && typeof item === 'object' && 'plan' in item && !('title' in item)
}

// Mutates trip.days from the legacy shape to time blocks. Returns true if changed.
export function migrateTripDays(trip) {
  let changed = false
  for (const day of Object.values(trip.days ?? {})) {
    if (Array.isArray(day.items) && day.items.some(isLegacyItem)) {
      day.items = convertLegacyItems(day.items)
      if (!('title' in day)) day.title = ''
      changed = true
    }
  }
  return changed
}

export function buildMapsUrl(waypoints) {
  const stops = (waypoints ?? []).map((w) => String(w).trim()).filter(Boolean)
  if (stops.length < 2) return ''
  const origin = encodeURIComponent(stops[0])
  const destination = encodeURIComponent(stops[stops.length - 1])
  const mid = stops.slice(1, -1).map(encodeURIComponent).join('%7C')
  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}`
  if (mid) url += `&waypoints=${mid}`
  return url
}
