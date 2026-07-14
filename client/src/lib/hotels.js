// Hotel-stay helpers. A stay covers a date when checkInDay <= date < checkOutDay
// (the check-out day itself is not covered — you sleep elsewhere that night).
// Plain string comparison is correct for YYYY-MM-DD dates.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function stayCoversDay(stay, date) {
  return stay.checkInDay <= date && date < stay.checkOutDay
}

export function staysForDay(stays, date) {
  return (stays ?? []).filter((s) => stayCoversDay(s, date))
}

export function checkInsOn(stays, date) {
  return (stays ?? []).filter((s) => s.checkInDay === date)
}

export function checkOutsOn(stays, date) {
  return (stays ?? []).filter((s) => s.checkOutDay === date)
}

// Coverage only — callers must also consider the day's hotelNotNeeded flag.
export function isMissingStay(stays, date) {
  return !(stays ?? []).some((s) => stayCoversDay(s, date))
}

// Returns an error message for the add/edit form, or null when valid.
export function validateStay(stay) {
  if (!stay.hotelName?.trim()) return 'Enter the hotel name.'
  if (!DATE_RE.test(stay.checkInDay ?? '')) return 'Choose a check-in date.'
  if (!DATE_RE.test(stay.checkOutDay ?? '')) return 'Choose a check-out date.'
  if (stay.checkOutDay <= stay.checkInDay) return 'Check-out must be after check-in.'
  return null
}

export function nextDay(dateStr) {
  if (!DATE_RE.test(dateStr ?? '')) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

export function mapsSearchUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
}
