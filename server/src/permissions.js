// Trip permission checks, shared by the REST routes and the AI agent's
// write-through for linked days.
// Legacy trips (created before accounts existed) have no ownerId; they are
// treated as public and any signed-in user may edit or delete them.
export function canView(trip, username) {
  if (!trip.ownerId) return true
  if (trip.visibility === 'public') return true
  if (!username) return false
  return trip.ownerId === username || (trip.sharedWith ?? []).includes(username)
}

export function canEdit(trip, username) {
  if (!username) return false
  if (!trip.ownerId) return true
  return trip.ownerId === username || (trip.sharedWith ?? []).includes(username)
}

export function isOwner(trip, username) {
  if (!username) return false
  return trip.ownerId ? trip.ownerId === username : true
}
