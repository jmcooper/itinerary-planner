import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'
import { formatRange } from '../lib/dates.js'

export default function HomePage() {
  const { user } = useAuth()
  const [trips, setTrips] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (user === undefined) return
    api
      .listTrips()
      .then(setTrips)
      .catch((err) => setError(err.message))
  }, [user])

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
          <Link to="/trips/new" className="btn btn-primary">
            Create Trip
          </Link>
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
      ) : trips.mine.length + trips.shared.length + trips.public.length === 0 ? (
        <p className="empty-note">No trips yet — create your first itinerary above.</p>
      ) : (
        <>
          {user && trips.mine.length > 0 && (
            <TripSection title="My Trips" trips={trips.mine} onDelete={handleDelete} />
          )}
          {user && trips.shared.length > 0 && (
            <TripSection title="Trips Shared with Me" trips={trips.shared} withOwner />
          )}
          {trips.public.length > 0 && (
            <TripSection title="Public Trips" trips={trips.public} withOwner />
          )}
        </>
      )}
    </div>
  )
}

function TripSection({ title, trips, onDelete, withOwner }) {
  return (
    <section className="trip-section">
      <h2 className="trip-section-title">{title}</h2>
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
    </section>
  )
}
