import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { formatRange } from '../lib/dates.js'

export default function HomePage() {
  const [trips, setTrips] = useState(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    api
      .listTrips()
      .then(setTrips)
      .catch((err) => setError(err.message))
  }, [])

  async function handleCreate(e) {
    e.preventDefault()
    if (!name.trim() || creating) return
    setCreating(true)
    setError('')
    try {
      const trip = await api.createTrip(name.trim())
      navigate(`/trips/${trip.id}`)
    } catch (err) {
      setError(err.message)
      setCreating(false)
    }
  }

  async function handleDelete(trip) {
    if (!window.confirm(`Delete "${trip.name}"? This cannot be undone.`)) return
    try {
      await api.deleteTrip(trip.id)
      setTrips((prev) => prev.filter((t) => t.id !== trip.id))
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="home">
      <section className="hero">
        <h1>Your Trip Itineraries</h1>
        <p className="hero-sub">Plan every day of your next adventure, one stop at a time.</p>
        <form className="create-form" onSubmit={handleCreate}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New trip name, e.g. Europe 2026"
            aria-label="New trip name"
            maxLength={120}
          />
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || creating}>
            {creating ? 'Creating…' : 'Create Trip'}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </section>

      {trips === null ? (
        <p className="empty-note">Loading trips…</p>
      ) : trips.length === 0 ? (
        <p className="empty-note">No trips yet — create your first itinerary above.</p>
      ) : (
        <ul className="trip-list">
          {trips.map((trip) => (
            <li key={trip.id} className="trip-card">
              <Link to={`/trips/${trip.id}`} className="trip-card-link">
                <span className="trip-card-name">{trip.name}</span>
                <span className="trip-card-dates">{formatRange(trip.startDate, trip.endDate)}</span>
              </Link>
              <button
                type="button"
                className="btn btn-ghost btn-danger"
                onClick={() => handleDelete(trip)}
                aria-label={`Delete ${trip.name}`}
                title="Delete trip"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
