async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  })
  if (res.status === 204) return null
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)
  return body
}

export const api = {
  register: (username, password) =>
    fetchJson('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username, password) =>
    fetchJson('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => fetchJson('/api/auth/logout', { method: 'POST' }),
  me: () => fetchJson('/api/auth/me'),
  listUsers: () => fetchJson('/api/users'),
  listTrips: () => fetchJson('/api/trips'),
  createTrip: (name) => fetchJson('/api/trips', { method: 'POST', body: JSON.stringify({ name }) }),
  getTrip: (id) => fetchJson(`/api/trips/${id}`),
  updateTrip: (id, patch) =>
    fetchJson(`/api/trips/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteTrip: (id) => fetchJson(`/api/trips/${id}`, { method: 'DELETE' }),
  aiStatus: () => fetchJson('/api/ai/status'),
  createAiTrip: (description) =>
    fetchJson('/api/trips/ai', { method: 'POST', body: JSON.stringify({ description }) }),
  getChat: (tripId) => fetchJson(`/api/trips/${tripId}/chat`),
  // POSTs a chat message and parses the SSE response body, invoking
  // onEvent(event, data) per frame. Resolves when the stream ends.
  streamChat: async (tripId, message, { model, onEvent }) => {
    const res = await fetch(`/api/trips/${tripId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ message, model }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.error ?? `Request failed (${res.status})`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const event = frame.match(/^event: (.*)$/m)?.[1]
        const data = frame.match(/^data: (.*)$/m)?.[1]
        if (event) onEvent(event, data ? JSON.parse(data) : {})
      }
    }
  },
  getImage: (tripId, imageId) => fetchJson(`/api/trips/${tripId}/images/${imageId}`),
  uploadImage: (tripId, dataUri) =>
    fetchJson(`/api/trips/${tripId}/images`, { method: 'POST', body: JSON.stringify({ dataUri }) }),
  deleteImage: (tripId, imageId) =>
    fetchJson(`/api/trips/${tripId}/images/${imageId}`, { method: 'DELETE' }),
}
