import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'
import { formatRange } from '../lib/dates.js'
import { CopyIcon } from '../components/icons.jsx'

export default function HomePage() {
  const { user } = useAuth()
  const [trips, setTrips] = useState(null)
  const [showArchived, setShowArchived] = useState(false)
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

  async function handleDuplicate(trip) {
    try {
      await api.duplicateTrip(trip.id)
      setTrips(await api.listTrips()) // reload so the copy's summary matches the server's
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleUnarchive(trip) {
    try {
      await api.updateTrip(trip.id, { archived: false })
      setTrips(await api.listTrips())
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
        <HomeSections
          user={user}
          trips={trips}
          showArchived={showArchived}
          onToggleArchived={() => setShowArchived((v) => !v)}
          onDelete={handleDelete}
          onDuplicate={handleDuplicate}
          onUnarchive={handleUnarchive}
        />
      )}
    </div>
  )
}

function HomeSections({ user, trips, showArchived, onToggleArchived, onDelete, onDuplicate, onUnarchive }) {
  const active = (list) => list.filter((t) => !t.archived)
  const mine = active(trips.mine)
  const shared = active(trips.shared)
  const pub = active(trips.public)
  // Everything archived the user can see, in one section; own trips get an
  // unarchive shortcut.
  const archived = [
    ...trips.mine.filter((t) => t.archived).map((t) => ({ ...t, mine: true })),
    ...trips.shared.filter((t) => t.archived),
    ...trips.public.filter((t) => t.archived),
  ]

  return (
    <>
      {user && mine.length > 0 && (
        <TripSection title="My Trips" trips={mine} onDelete={onDelete} onDuplicate={onDuplicate} />
      )}
      {user && shared.length > 0 && (
        <TripSection title="Trips Shared with Me" trips={shared} withOwner />
      )}
      {pub.length > 0 && <TripSection title="Public Trips" trips={pub} withOwner />}
      {archived.length > 0 && (
        <>
          {showArchived && (
            <TripSection title="Archived Trips" trips={archived} withOwner onUnarchive={onUnarchive} />
          )}
          <p className="archived-toggle-row">
            <button type="button" className="archived-toggle" onClick={onToggleArchived}>
              {showArchived
                ? 'Hide archived trips'
                : `Show archived trips (${archived.length})`}
            </button>
          </p>
        </>
      )}
    </>
  )
}

function TripSection({ title, trips, onDelete, onDuplicate, onUnarchive, withOwner }) {
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
                {withOwner && trip.ownerId && !trip.mine && (
                  <span className="trip-card-owner"> · by {trip.ownerId}</span>
                )}
              </span>
            </Link>
            {onUnarchive && trip.mine && (
              <button
                type="button"
                className="btn btn-ghost btn-small trip-card-unarchive"
                onClick={() => onUnarchive(trip)}
              >
                Unarchive
              </button>
            )}
            {onDuplicate && (
              <button
                type="button"
                className="btn btn-ghost trip-card-copy"
                onClick={() => onDuplicate(trip)}
                aria-label={`Duplicate ${trip.name}`}
                title="Duplicate trip"
              >
                <CopyIcon />
              </button>
            )}
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
