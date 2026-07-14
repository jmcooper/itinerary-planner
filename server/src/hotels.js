// Hotel-stay validation shared by the REST PUT handler and the AI agent's
// updateItinerary tool. A stay covers checkInDay (inclusive) through
// checkOutDay (exclusive) — the check-out day itself needs its own stay.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

// Validates and normalizes a hotel-stays payload. Returns { stays } on
// success or { error } on the first problem. Only known fields are kept
// (trimmed), so junk can't accumulate in the trip JSON.
export function normalizeHotelStays(input) {
  if (!Array.isArray(input)) return { error: 'hotelStays must be an array' }
  const stays = []
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null)
      return { error: 'each hotel stay must be an object' }
    const hotelName = typeof raw.hotelName === 'string' ? raw.hotelName.trim() : ''
    if (!hotelName) return { error: 'each hotel stay needs a hotelName' }
    if (raw.hotelAddress != null && typeof raw.hotelAddress !== 'string')
      return { error: 'hotelAddress must be a string' }
    if (!DAY_RE.test(raw.checkInDay ?? '') || !DAY_RE.test(raw.checkOutDay ?? ''))
      return { error: 'checkInDay and checkOutDay must be YYYY-MM-DD dates' }
    if (raw.checkOutDay <= raw.checkInDay)
      return { error: 'checkOutDay must be after checkInDay' }
    if (raw.confirmationNumber != null && typeof raw.confirmationNumber !== 'string')
      return { error: 'confirmationNumber must be a string' }
    const stay = {
      hotelName,
      hotelAddress: (raw.hotelAddress ?? '').trim(),
      checkInDay: raw.checkInDay,
      checkOutDay: raw.checkOutDay,
    }
    const conf = (raw.confirmationNumber ?? '').trim()
    if (conf) stay.confirmationNumber = conf
    stays.push(stay)
  }
  return { stays }
}
