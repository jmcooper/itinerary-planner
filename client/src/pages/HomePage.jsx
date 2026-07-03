import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'
import { formatRange } from '../lib/dates.js'

export default function HomePage() {
  const { user } = useAuth()
  const [trips, setTrips] = useState(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    if (user === undefined) return
    api
      .listTrips()
      .then(setTrips)
      .catch((err) => setError(err.message))
  }, [user])

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
      setTrips((prev) => ({ ...prev, mine: prev.mine.filter((t) => t.id !== trip.id) }))
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="home">
      <section className="hero">
        <h1>Your Trip Itineraries</h1>
        <p className="hero-sub">Plan every day of your next adventure, one stop at a time.</p>
        {user ? (
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
        ) : (
          user === null && (
            <p className="hero-signin">
              <Link to="/signin">Sign in</Link> to create and manage your own trips.
            </p>
          )
        )}
        {error && <p className="error">{error}</p>}
      </section>

      {trips === null ? (
        <p className="empty-note">Loading trips…</p>
      ) : (
        <>
          {user && (
            <TripSection
              title="My Trips"
              trips={trips.mine}
              emptyNote="No trips yet — create your first itinerary above."
              onDelete={handleDelete}
            />
          )}
          {user && (
            <TripSection
              title="Trips Shared with Me"
              trips={trips.shared}
              emptyNote="No one has shared a trip with you yet."
              withOwner
            />
          )}
          <TripSection
            title="Public Trips"
            trips={trips.public}
            emptyNote="No public trips yet."
            withOwner
          />
        </>
      )}
    </div>
  )
}

function TripSection({ title, trips, emptyNote, onDelete, withOwner }) {
  return (
    <section className="trip-section">
      <h2 className="trip-section-title">{title}</h2>
      {trips.length === 0 ? (
        <p className="empty-note">{emptyNote}</p>
      ) : (
        <ul className="trip-list">
          {trips.map((trip) => (
            <li key={trip.id} className="trip-card">
              <Link to={`/trips/${trip.id}`} className="trip-card-link">
                <span className="trip-card-name">{trip.name}</span>
                <span className="trip-card-dates">
                  {formatRange(trip.startDate, trip.endDate)}
                  {withOwner && trip.ownerId && (
                    <span className="trip-card-owner"> · by {trip.ownerId}</span>
                  )}
                </span>
              </Link>
              {onDelete && (
                <button
                  type="button"
                  className="btn btn-ghost btn-danger"
                  onClick={() => onDelete(trip)}
                  aria-label={`Delete ${trip.name}`}
                  title="Delete trip"
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
