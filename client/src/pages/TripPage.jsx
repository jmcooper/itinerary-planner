import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api.js'
import { listDates, formatDay, formatRange } from '../lib/dates.js'
import DayView from '../components/DayView.jsx'

export default function TripPage() {
  const { id } = useParams()
  const [trip, setTrip] = useState(null)
  const [error, setError] = useState('')
  const [selectedDate, setSelectedDate] = useState(null)
  const [editingDates, setEditingDates] = useState(false)

  useEffect(() => {
    api
      .getTrip(id)
      .then((t) => {
        setTrip(t)
        const dates = listDates(t.startDate, t.endDate)
        if (dates.length > 0) setSelectedDate(dates[0])
      })
      .catch((err) => setError(err.message))
  }, [id])

  async function saveTrip(patch) {
    const updated = await api.updateTrip(id, patch)
    setTrip(updated)
    return updated
  }

  if (error) {
    return (
      <div className="empty-note">
        <p className="error">{error}</p>
        <Link to="/">← Back to trips</Link>
      </div>
    )
  }
  if (!trip) return <p className="empty-note">Loading trip…</p>

  const dates = listDates(trip.startDate, trip.endDate)
  const needsDates = dates.length === 0 || editingDates

  return (
    <div className="trip">
      <div className="trip-header">
        <div>
          <nav className="breadcrumb">
            <Link to="/">Trips</Link> <span aria-hidden="true">/</span>
          </nav>
          <h1>{trip.name}</h1>
          <p className="trip-dates-line">
            {formatRange(trip.startDate, trip.endDate)}
            {dates.length > 0 && !editingDates && (
              <button type="button" className="btn btn-link" onClick={() => setEditingDates(true)}>
                Change dates
              </button>
            )}
          </p>
        </div>
      </div>

      {needsDates ? (
        <DateRangeForm
          trip={trip}
          onCancel={dates.length > 0 ? () => setEditingDates(false) : null}
          onSave={async (startDate, endDate) => {
            const updated = await saveTrip({ startDate, endDate })
            setEditingDates(false)
            const newDates = listDates(updated.startDate, updated.endDate)
            if (!newDates.includes(selectedDate)) setSelectedDate(newDates[0] ?? null)
          }}
        />
      ) : (
        <div className="trip-body">
          <aside className="day-nav" aria-label="Trip days">
            <ol>
              {dates.map((date, i) => {
                const { weekday, label } = formatDay(date)
                const hasItems = (trip.days?.[date]?.items?.length ?? 0) > 0
                return (
                  <li key={date}>
                    <button
                      type="button"
                      className={`day-nav-item${date === selectedDate ? ' selected' : ''}`}
                      onClick={() => setSelectedDate(date)}
                    >
                      <span className="day-nav-num">Day {i + 1}</span>
                      <span className="day-nav-date">
                        {weekday}, {label}
                      </span>
                      <span
                        className={`day-nav-dot${hasItems ? ' filled' : ''}`}
                        title={hasItems ? 'Itinerary added' : 'No itinerary yet'}
                      />
                    </button>
                  </li>
                )
              })}
            </ol>
          </aside>
          <section className="day-panel">
            {selectedDate ? (
              <DayView
                key={selectedDate}
                tripId={trip.id}
                date={selectedDate}
                dayIndex={dates.indexOf(selectedDate)}
                day={trip.days?.[selectedDate] ?? {}}
                onSaveDay={(patch) =>
                  saveTrip({
                    days: {
                      ...trip.days,
                      [selectedDate]: { ...(trip.days?.[selectedDate] ?? {}), ...patch },
                    },
                  })
                }
              />
            ) : (
              <p className="empty-note">Select a day on the left.</p>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function DateRangeForm({ trip, onSave, onCancel }) {
  const [startDate, setStartDate] = useState(trip.startDate ?? '')
  const [endDate, setEndDate] = useState(trip.endDate ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!startDate || !endDate) return setError('Choose both a start and end date.')
    if (endDate < startDate) return setError('The end date must be on or after the start date.')
    if (listDates(startDate, endDate).length > 60)
      return setError('Trips are limited to 60 days.')
    setSaving(true)
    setError('')
    try {
      await onSave(startDate, endDate)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <form className="date-range-form card" onSubmit={handleSubmit}>
      <h2>When is this trip?</h2>
      <p className="muted">Pick the date range — each day gets its own itinerary.</p>
      <div className="date-range-inputs">
        <label>
          Start date
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
        </label>
        <span className="date-range-sep" aria-hidden="true">→</span>
        <label>
          End date
          <input type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} required />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Set Dates'}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}
