import { useState } from 'react'
import Modal from './Modal.jsx'
import { CopyButton, ConfirmationPill } from './HotelStaysModal.jsx'
import { PencilIcon, TrashIcon } from './icons.jsx'
import { formatDay } from '../lib/dates.js'
import { flightDate, flightClock, validateFlightTrip, seatClassKind } from '../lib/flights.js'

function to12h(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`
}

function dayLabel(date) {
  const { weekday, label } = formatDay(date)
  return `${weekday}, ${label}`
}

// "Fri, Jul 17 · 3:00 PM → 6:05 PM", with the arrival day prefixed when the
// flight lands on a different date (overnight).
function formatFlightTimes(flight) {
  const dep = `${dayLabel(flightDate(flight.departureTime))} · ${to12h(flightClock(flight.departureTime))}`
  const sameDay = flightDate(flight.departureTime) === flightDate(flight.arrivalTime)
  const arr = sameDay
    ? to12h(flightClock(flight.arrivalTime))
    : `${dayLabel(flightDate(flight.arrivalTime))} · ${to12h(flightClock(flight.arrivalTime))}`
  return `${dep} → ${arr}`
}

function SeatChips({ seats }) {
  if (!seats?.length) return null
  return (
    <div className="flight-seats">
      {seats.map((seat, i) => (
        <span
          key={i}
          className={`seat-chip seat-chip-${seatClassKind(seat.class)}`}
          title={seat.class || 'Economy'}
        >
          {seat.seatNumber}
        </span>
      ))}
    </div>
  )
}

function FlightLine({ flight }) {
  return (
    <div className="flight-line">
      <div>
        <span className="flight-number">{flight.flightNumber || 'Flight'}</span>
        <span className="flight-times"> {formatFlightTimes(flight)}</span>
      </div>
      {flight.ticketNumber && (
        <div className="flight-ticket">
          Ticket # {flight.ticketNumber}
          <CopyButton text={flight.ticketNumber} label="Copy ticket number" size={12} />
        </div>
      )}
      <SeatChips seats={flight.seats} />
    </div>
  )
}

// Confirmation pill + all of the booking's flights on one tinted group, so
// the confirmation # and its flights read as a single reservation.
function FlightTripInfo({ flightTrip }) {
  const flights = [...(flightTrip.flights ?? [])].sort((a, b) =>
    a.departureTime.localeCompare(b.departureTime)
  )
  return (
    <div className="flight-trip-group">
      {flightTrip.confirmationNumber ? (
        <ConfirmationPill value={flightTrip.confirmationNumber} />
      ) : (
        <p className="muted hotel-stay-no-conf">No confirmation # on file.</p>
      )}
      {flights.map((flight, i) => (
        <FlightLine key={i} flight={flight} />
      ))}
      {flightTrip.linkedTripName && (
        <p className="muted hotel-stay-source">From “{flightTrip.linkedTripName}” via a linked day</p>
      )}
    </div>
  )
}

const EMPTY_FLIGHT = { flightNumber: '', departureTime: '', arrivalTime: '', ticketNumber: '' }
const EMPTY_SEAT = { class: '', seatNumber: '' }

function FlightTripForm({ initial, onSubmit, onCancel }) {
  const [confirmationNumber, setConfirmationNumber] = useState(initial?.confirmationNumber ?? '')
  const [flights, setFlights] = useState(() => {
    const list = (initial?.flights ?? []).map((f) => ({
      ...EMPTY_FLIGHT,
      ...f,
      seats: (f.seats ?? []).map((s) => ({ ...EMPTY_SEAT, ...s })),
    }))
    return list.length ? list : [{ ...EMPTY_FLIGHT, seats: [] }]
  })
  const [error, setError] = useState('')

  const update = (i, patch) => setFlights(flights.map((f, idx) => (idx === i ? { ...f, ...patch } : f)))
  const setSeatField = (i, s, field, value) =>
    update(i, { seats: flights[i].seats.map((seat, idx) => (idx === s ? { ...seat, [field]: value } : seat)) })

  function handleSubmit(e) {
    e.preventDefault()
    const flightTrip = {
      confirmationNumber: confirmationNumber.trim(),
      flights: flights.map((f) => ({
        flightNumber: f.flightNumber.trim(),
        departureTime: f.departureTime,
        arrivalTime: f.arrivalTime,
        ticketNumber: f.ticketNumber.trim(),
        // Drop seat rows left entirely blank (stray "+ Add seat" clicks).
        seats: f.seats
          .filter((s) => s.class.trim() || s.seatNumber.trim())
          .map((s) => ({ seatNumber: s.seatNumber.trim(), ...(s.class.trim() ? { class: s.class.trim() } : {}) })),
      })),
    }
    const problem = validateFlightTrip(flightTrip)
    if (problem) return setError(problem)
    onSubmit(flightTrip)
  }

  return (
    <form className="hotel-stay-form" onSubmit={handleSubmit}>
      <label>
        Confirmation # (optional)
        <input type="text" value={confirmationNumber} onChange={(e) => setConfirmationNumber(e.target.value)} />
      </label>
      <div className="conf-editor">
        <span className="conf-editor-title">Flights</span>
        {flights.map((flight, i) => (
          <fieldset key={i} className="conf-block">
            <div className="conf-block-head">
              <label>
                Flight # (e.g. DL1048)
                <input
                  type="text"
                  value={flight.flightNumber}
                  onChange={(e) => update(i, { flightNumber: e.target.value })}
                />
              </label>
              <button
                type="button"
                className="btn-icon btn-icon-danger"
                title="Remove flight"
                aria-label={`Remove flight ${flight.flightNumber || i + 1}`}
                onClick={() => setFlights(flights.filter((_, idx) => idx !== i))}
              >
                <TrashIcon />
              </button>
            </div>
            <div className="hotel-stay-form-dates">
              <label>
                Departure
                <input
                  type="datetime-local"
                  value={flight.departureTime}
                  onChange={(e) => update(i, { departureTime: e.target.value })}
                  required
                />
              </label>
              <label>
                Arrival
                <input
                  type="datetime-local"
                  value={flight.arrivalTime}
                  min={flight.departureTime || undefined}
                  onChange={(e) => update(i, { arrivalTime: e.target.value })}
                  required
                />
              </label>
            </div>
            <label>
              Ticket # (optional)
              <input
                type="text"
                value={flight.ticketNumber}
                onChange={(e) => update(i, { ticketNumber: e.target.value })}
              />
            </label>
            {flight.seats.map((seat, s) => (
              <div key={s} className="conf-room">
                <input
                  type="text"
                  placeholder="Class (e.g. Comfort+)"
                  aria-label="Seat class"
                  value={seat.class}
                  onChange={(e) => setSeatField(i, s, 'class', e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Seat (e.g. 14E)"
                  aria-label="Seat number"
                  value={seat.seatNumber}
                  onChange={(e) => setSeatField(i, s, 'seatNumber', e.target.value)}
                />
                <button
                  type="button"
                  className="btn-icon btn-icon-danger"
                  title="Remove seat"
                  aria-label={`Remove seat ${s + 1}`}
                  onClick={() => update(i, { seats: flight.seats.filter((_, idx) => idx !== s) })}
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn btn-link conf-add-btn"
              onClick={() => update(i, { seats: [...flight.seats, { ...EMPTY_SEAT }] })}
            >
              + Add seat
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="btn btn-link conf-add-btn"
          onClick={() => setFlights([...flights, { ...EMPTY_FLIGHT, seats: [] }])}
        >
          + Add flight
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary btn-small">
          Save Flights
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// All of a trip's flight trips. onSave receives the full replacement array
// (flight trips live at the trip level).
export function FlightsModal({
  flightTrips,
  linkedFlightTrips = [], // read-only: owned by trips linked from here
  canEdit,
  onSave,
  onClose,
  initialAdd = false,
}) {
  // null = list view; -1 = adding; >= 0 = editing that index
  const [editing, setEditing] = useState(initialAdd ? -1 : null)
  const [error, setError] = useState('')
  const earliest = (ft) =>
    (ft.flights ?? []).reduce((min, f) => (min && min < f.departureTime ? min : f.departureTime), '')
  const sorted = [
    ...flightTrips.map((ft, index) => ({ ft, index })),
    ...linkedFlightTrips.map((ft) => ({ ft, index: null })),
  ]
  sorted.sort((a, b) => earliest(a.ft).localeCompare(earliest(b.ft)))

  async function save(next) {
    setError('')
    try {
      await onSave(next)
      setEditing(null)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <Modal title="Flights" onClose={onClose}>
      {editing !== null ? (
        <FlightTripForm
          initial={editing >= 0 ? flightTrips[editing] : null}
          onSubmit={(ft) => {
            const next = [...flightTrips]
            if (editing >= 0) next[editing] = ft
            else next.push(ft)
            save(next)
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <>
          {sorted.length === 0 && (
            <p className="muted hotel-stays-empty">
              No flights yet{canEdit ? ' — add your first booking below.' : '.'}
            </p>
          )}
          <ul className="hotel-stay-list">
            {sorted.map(({ ft, index }, i) => (
              <li key={index ?? `linked-${i}`} className="hotel-stay-card">
                <div className="hotel-stay-info">
                  <FlightTripInfo flightTrip={ft} />
                </div>
                {canEdit && index !== null && (
                  <div className="hotel-stay-actions">
                    <button
                      type="button"
                      className="btn-icon"
                      title="Edit flights"
                      aria-label={`Edit flight trip ${ft.confirmationNumber || index + 1}`}
                      onClick={() => setEditing(index)}
                    >
                      <PencilIcon />
                    </button>
                    <button
                      type="button"
                      className="btn-icon btn-icon-danger"
                      title="Delete flights"
                      aria-label={`Delete flight trip ${ft.confirmationNumber || index + 1}`}
                      onClick={() => {
                        if (window.confirm('Delete this flight trip?'))
                          save(flightTrips.filter((_, idx) => idx !== index))
                      }}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {error && <p className="error">{error}</p>}
          {canEdit && (
            <button type="button" className="btn btn-primary btn-small" onClick={() => setEditing(-1)}>
              Add Flight Trip
            </button>
          )}
        </>
      )}
    </Modal>
  )
}

// Single flight trip opened from a day's plane icon. Own flight trips can be
// edited in place; linked ones are read-only (they belong to the linked trip).
export function FlightTripDetail({ flightTrip, canEdit = false, onSave, onClose }) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')

  async function save(ft) {
    setError('')
    try {
      await onSave(ft)
      setEditing(false)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <Modal title="Flights" onClose={onClose}>
      {editing ? (
        <>
          <FlightTripForm initial={flightTrip} onSubmit={save} onCancel={() => setEditing(false)} />
          {error && <p className="error">{error}</p>}
        </>
      ) : (
        <div className="hotel-stay-info hotel-stay-detail">
          {canEdit && (
            <div className="flight-detail-actions">
              <button
                type="button"
                className="btn-icon"
                title="Edit flights"
                aria-label="Edit flights"
                onClick={() => setEditing(true)}
              >
                <PencilIcon />
              </button>
            </div>
          )}
          <FlightTripInfo flightTrip={flightTrip} />
        </div>
      )}
    </Modal>
  )
}
