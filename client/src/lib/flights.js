// Flight-trip helpers. Times are local wall-clock strings (YYYY-MM-DDTHH:MM);
// timezones are deliberately ignored, so plain string slicing and comparison
// are correct for this format.

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

export const flightDate = (dt) => (dt ?? '').slice(0, 10)
export const flightClock = (dt) => (dt ?? '').slice(11, 16)

// A flight touches a date when it departs OR arrives that day, so an
// overnight flight shows on both tiles.
export function flightTouchesDay(flight, date) {
  return flightDate(flight.departureTime) === date || flightDate(flight.arrivalTime) === date
}

export function flightsTouchingDay(flightTrips, date) {
  return (flightTrips ?? []).flatMap((ft) =>
    (ft.flights ?? []).filter((f) => flightTouchesDay(f, date))
  )
}

export function flightTripsTouchingDay(flightTrips, date) {
  return (flightTrips ?? []).filter((ft) =>
    (ft.flights ?? []).some((f) => flightTouchesDay(f, date))
  )
}

// Returns an error message for the add/edit form, or null when valid.
export function validateFlightTrip(ft) {
  if (!(ft.flights ?? []).length) return 'Add at least one flight.'
  for (const flight of ft.flights) {
    if (!DATETIME_RE.test(flight.departureTime ?? ''))
      return 'Every flight needs a departure date & time.'
    if (!DATETIME_RE.test(flight.arrivalTime ?? ''))
      return 'Every flight needs an arrival date & time.'
    if (flight.arrivalTime <= flight.departureTime) return 'Arrival must be after departure.'
    for (const seat of flight.seats ?? []) {
      if (!seat.seatNumber?.trim()) return 'Every seat needs a seat number.'
    }
  }
  return null
}

// Delta-style chip color: blue for Comfort+/premium-plus cabins, red for
// first class, plain for economy/coach/unknown.
export function seatClassKind(cls) {
  if (/comfort|plus/i.test(cls ?? '')) return 'plus'
  if (/first/i.test(cls ?? '')) return 'first'
  return 'plain'
}
