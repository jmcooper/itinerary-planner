// Flight-trip validation shared by the REST PUT handler and the AI agent's
// updateItinerary tool. A "flight trip" is one booking: a confirmation number
// shared by one or more flights (round trips and multi-city itineraries).
// Times are local wall-clock date+times; timezones are deliberately ignored,
// so plain string comparison orders them correctly.

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

// Validates and normalizes a flight-trips payload. Returns { flightTrips } on
// success or { error } on the first problem. Only known fields are kept
// (trimmed), so junk can't accumulate in the trip JSON.
export function normalizeFlightTrips(input) {
  if (!Array.isArray(input)) return { error: 'flightTrips must be an array' }
  const flightTrips = []
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null)
      return { error: 'each flight trip must be an object' }
    if (raw.confirmationNumber != null && typeof raw.confirmationNumber !== 'string')
      return { error: 'confirmationNumber must be a string' }
    if (!Array.isArray(raw.flights) || raw.flights.length === 0)
      return { error: 'each flight trip needs at least one flight' }
    const flights = []
    for (const rawFlight of raw.flights) {
      if (typeof rawFlight !== 'object' || rawFlight === null)
        return { error: 'each flight must be an object' }
      if (
        !DATETIME_RE.test(rawFlight.departureTime ?? '') ||
        !DATETIME_RE.test(rawFlight.arrivalTime ?? '')
      )
        return { error: 'departureTime and arrivalTime must be YYYY-MM-DDTHH:MM' }
      if (rawFlight.arrivalTime <= rawFlight.departureTime)
        return { error: 'arrivalTime must be after departureTime' }
      const flight = {
        departureTime: rawFlight.departureTime,
        arrivalTime: rawFlight.arrivalTime,
        seats: [],
      }
      for (const field of ['flightNumber', 'ticketNumber', 'departureAirport', 'arrivalAirport']) {
        if (rawFlight[field] != null && typeof rawFlight[field] !== 'string')
          return { error: `${field} must be a string` }
        let value = (rawFlight[field] ?? '').trim()
        // Airport codes read best uppercase (slc → SLC).
        if (field.endsWith('Airport') && /^[a-z0-9]{3,4}$/i.test(value)) value = value.toUpperCase()
        if (value) flight[field] = value
      }
      if (rawFlight.seats != null) {
        if (!Array.isArray(rawFlight.seats)) return { error: 'seats must be an array' }
        for (const rawSeat of rawFlight.seats) {
          if (typeof rawSeat !== 'object' || rawSeat === null)
            return { error: 'each seat must be an object' }
          const seatNumber =
            typeof rawSeat.seatNumber === 'string' ? rawSeat.seatNumber.trim() : ''
          if (!seatNumber) return { error: 'each seat needs a seatNumber' }
          if (rawSeat.class != null && typeof rawSeat.class !== 'string')
            return { error: 'seat class must be a string' }
          const seat = { seatNumber }
          const cls = (rawSeat.class ?? '').trim()
          if (cls) seat.class = cls
          flight.seats.push(seat)
        }
      }
      flights.push(flight)
    }
    const flightTrip = {}
    const conf = (raw.confirmationNumber ?? '').trim()
    if (conf) flightTrip.confirmationNumber = conf
    flightTrip.flights = flights
    flightTrips.push(flightTrip)
  }
  return { flightTrips }
}
