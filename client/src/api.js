async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (res.status === 204) return null
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)
  return body
}

export const api = {
  listTrips: () => fetchJson('/api/trips'),
  createTrip: (name) => fetchJson('/api/trips', { method: 'POST', body: JSON.stringify({ name }) }),
  getTrip: (id) => fetchJson(`/api/trips/${id}`),
  updateTrip: (id, patch) =>
    fetchJson(`/api/trips/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteTrip: (id) => fetchJson(`/api/trips/${id}`, { method: 'DELETE' }),
  getImage: (tripId, imageId) => fetchJson(`/api/trips/${tripId}/images/${imageId}`),
  uploadImage: (tripId, dataUri) =>
    fetchJson(`/api/trips/${tripId}/images`, { method: 'POST', body: JSON.stringify({ dataUri }) }),
  deleteImage: (tripId, imageId) =>
    fetchJson(`/api/trips/${tripId}/images/${imageId}`, { method: 'DELETE' }),
}
