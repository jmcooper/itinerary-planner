// Day-level links between trips. A linked day is stored as a bare marker —
// { linkedTripId } — and never carries content of its own; the target trip's
// day (same date) is the single source of truth. Reads resolve the marker to
// the target day's content; writes to a linked day go to the target trip.
import { canEdit } from './permissions.js'

export function isLinkedDay(day) {
  return Boolean(day && typeof day === 'object' && day.linkedTripId)
}

// PUT payloads round-trip resolved days (which carry the target's content
// plus link metadata); storing only the marker keeps the data single-source.
// Plain days are also scrubbed of resolution metadata (linkedHotelStays and
// friends) so hotel data from a linked trip can never be persisted here.
export function normalizeLinkedDay(day) {
  if (isLinkedDay(day)) return { linkedTripId: String(day.linkedTripId) }
  if (day && typeof day === 'object') {
    const { linkedTripName, linkedCanEdit, linkedBroken, linkedHotelStays, ...clean } = day
    return clean
  }
  return day
}

// Shape-only validation: deeper checks (target exists, has the date, isn't
// itself linked) run at resolution time so a target deleted later never
// blocks unrelated saves — the day just resolves as a broken link.
export function validateLinkedDay(day, tripId) {
  if (!isLinkedDay(day)) return null
  if (typeof day.linkedTripId !== 'string' || !day.linkedTripId.trim())
    return 'linkedTripId must be a trip id'
  if (day.linkedTripId === tripId) return 'a day cannot link to its own trip'
  return null
}

// Returns a copy of the trip with linked days resolved to the target day's
// content plus metadata the client needs: linkedTripName (indicator),
// linkedCanEdit (whether this user's edits can write through), and
// linkedBroken when the target is missing, lacks the date, or is itself a
// link (chains are not followed).
export async function resolveTripDays(trip, { storage, username }) {
  const days = {}
  for (const [date, day] of Object.entries(trip.days ?? {})) {
    if (!isLinkedDay(day)) {
      days[date] = day
      continue
    }
    const target = await storage.readTrip(day.linkedTripId).catch(() => null)
    const targetDay = target?.days?.[date]
    if (!target || !targetDay || isLinkedDay(targetDay)) {
      days[date] = {
        linkedTripId: day.linkedTripId,
        linkedTripName: target?.name ?? null,
        linkedBroken: true,
        linkedCanEdit: false,
        title: '',
        mapsUrl: '',
        items: [],
      }
      continue
    }
    // Hotel stays are trip-level, so the target's stays touching this date
    // ride along — otherwise the linking trip would think the night is
    // uncovered and hide the check-in/check-out icons. The range is
    // inclusive of checkOutDay so check-out-day icons resolve too.
    const linkedHotelStays = (target.hotelStays ?? []).filter(
      (stay) => stay.checkInDay <= date && date <= stay.checkOutDay
    )
    days[date] = {
      ...targetDay,
      linkedTripId: day.linkedTripId,
      linkedTripName: target.name,
      linkedCanEdit: canEdit(target, username),
      ...(linkedHotelStays.length ? { linkedHotelStays } : {}),
    }
  }
  return { ...trip, days }
}
