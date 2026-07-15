// Hotel-stay validation shared by the REST PUT handler and the AI agent's
// updateItinerary tool. A stay covers checkInDay (inclusive) through
// checkOutDay (exclusive) — the check-out day itself needs its own stay.
//
// Each stay carries confirmations: [{ confirmationNumber, rooms }]. The
// legacy single confirmationNumber string was converted by the startup
// migration (server/src/migrate.js); on input it is an explicit error so
// stale clients can't silently lose data.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const ROOM_FIELDS = ['roomType', 'guests', 'notes']

// Validates one confirmations array. Returns { confirmations } or { error }.
function normalizeConfirmations(input) {
  if (!Array.isArray(input)) return { error: 'confirmations must be an array' }
  const confirmations = []
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null)
      return { error: 'each confirmation must be an object' }
    const confirmationNumber =
      typeof raw.confirmationNumber === 'string' ? raw.confirmationNumber.trim() : ''
    if (!confirmationNumber) return { error: 'each confirmation needs a confirmationNumber' }
    const rooms = []
    if (raw.rooms != null) {
      if (!Array.isArray(raw.rooms)) return { error: 'rooms must be an array' }
      for (const rawRoom of raw.rooms) {
        if (typeof rawRoom !== 'object' || rawRoom === null)
          return { error: 'each room must be an object' }
        const room = {}
        for (const field of ROOM_FIELDS) {
          if (rawRoom[field] != null && typeof rawRoom[field] !== 'string')
            return { error: `room ${field} must be a string` }
          const value = (rawRoom[field] ?? '').trim()
          if (value) room[field] = value
        }
        rooms.push(room)
      }
    }
    confirmations.push({ confirmationNumber, rooms })
  }
  return { confirmations }
}

// Validates and normalizes a hotel-stays payload. Returns { stays } on
// success or { error } on the first problem. Only known fields are kept
// (trimmed), so junk can't accumulate in the trip JSON.
export function normalizeHotelStays(input) {
  if (!Array.isArray(input)) return { error: 'hotelStays must be an array' }
  const stays = []
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null)
      return { error: 'each hotel stay must be an object' }
    if ('confirmationNumber' in raw)
      return { error: 'confirmationNumber has been replaced by confirmations' }
    const hotelName = typeof raw.hotelName === 'string' ? raw.hotelName.trim() : ''
    if (!hotelName) return { error: 'each hotel stay needs a hotelName' }
    if (raw.hotelAddress != null && typeof raw.hotelAddress !== 'string')
      return { error: 'hotelAddress must be a string' }
    if (!DAY_RE.test(raw.checkInDay ?? '') || !DAY_RE.test(raw.checkOutDay ?? ''))
      return { error: 'checkInDay and checkOutDay must be YYYY-MM-DD dates' }
    if (raw.checkOutDay <= raw.checkInDay)
      return { error: 'checkOutDay must be after checkInDay' }
    const stay = {
      hotelName,
      hotelAddress: (raw.hotelAddress ?? '').trim(),
      checkInDay: raw.checkInDay,
      checkOutDay: raw.checkOutDay,
    }
    if (raw.confirmations != null) {
      const { confirmations, error } = normalizeConfirmations(raw.confirmations)
      if (error) return { error }
      stay.confirmations = confirmations
    } else {
      stay.confirmations = []
    }
    stays.push(stay)
  }
  return { stays }
}
