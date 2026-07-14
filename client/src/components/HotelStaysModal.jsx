import { useState } from 'react'
import Modal from './Modal.jsx'
import { CopyIcon, PencilIcon, TrashIcon } from './icons.jsx'
import { formatDay } from '../lib/dates.js'
import { validateStay, nextDay, mapsSearchUrl } from '../lib/hotels.js'

function formatStayRange(stay) {
  const from = formatDay(stay.checkInDay)
  const to = formatDay(stay.checkOutDay)
  const nights = Math.round(
    (Date.parse(stay.checkOutDay) - Date.parse(stay.checkInDay)) / 86_400_000
  )
  return `${from.weekday}, ${from.label} → ${to.weekday}, ${to.label} · ${nights} night${nights === 1 ? '' : 's'}`
}

function ConfirmationNumber({ value }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <div className="hotel-stay-conf-row">
      <span className="hotel-stay-conf-label">Confirmation #</span>
      <span className="hotel-stay-conf">{value}</span>
      <button
        type="button"
        className="btn-icon"
        title="Copy confirmation number"
        aria-label="Copy confirmation number"
        onClick={() => {
          navigator.clipboard?.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? '✓' : <CopyIcon />}
      </button>
    </div>
  )
}

function StayInfo({ stay }) {
  return (
    <>
      <div className="hotel-stay-name">{stay.hotelName}</div>
      <div className="hotel-stay-dates">{formatStayRange(stay)}</div>
      <ConfirmationNumber value={stay.confirmationNumber} />
      {stay.hotelAddress && (
        <a
          className="hotel-stay-address"
          href={mapsSearchUrl(stay.hotelAddress)}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in Google Maps"
        >
          {stay.hotelAddress}
        </a>
      )}
    </>
  )
}

const EMPTY_FORM = {
  hotelName: '',
  hotelAddress: '',
  checkInDay: '',
  checkOutDay: '',
  confirmationNumber: '',
}

function StayForm({ initial, onSubmit, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const [error, setError] = useState('')
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }))

  function handleSubmit(e) {
    e.preventDefault()
    const problem = validateStay(form)
    if (problem) return setError(problem)
    onSubmit(form)
  }

  return (
    <form className="hotel-stay-form" onSubmit={handleSubmit}>
      <label>
        Hotel name
        <input type="text" value={form.hotelName} onChange={set('hotelName')} required />
      </label>
      <label>
        Address
        <input
          type="text"
          value={form.hotelAddress}
          onChange={set('hotelAddress')}
          placeholder="Street address for maps navigation"
        />
      </label>
      <div className="hotel-stay-form-dates">
        <label>
          Check-in
          <input type="date" value={form.checkInDay} onChange={set('checkInDay')} required />
        </label>
        <label>
          Check-out
          <input
            type="date"
            value={form.checkOutDay}
            min={nextDay(form.checkInDay) || undefined}
            onChange={set('checkOutDay')}
            required
          />
        </label>
      </div>
      <label>
        Confirmation # (optional)
        <input type="text" value={form.confirmationNumber} onChange={set('confirmationNumber')} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary btn-small">
          Save Stay
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// Add/view/edit all of a trip's hotel stays. onSave receives the full
// replacement array (stays live at the trip level).
export function HotelStaysModal({ stays, canEdit, onSave, onClose, initialAdd = false, prefillCheckIn = null }) {
  // null = list view; -1 = adding; >= 0 = editing that index
  const [editing, setEditing] = useState(initialAdd ? -1 : null)
  const [error, setError] = useState('')
  const sorted = [...stays].map((stay, index) => ({ stay, index }))
  sorted.sort((a, b) => a.stay.checkInDay.localeCompare(b.stay.checkInDay))

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
    <Modal title="Hotel stays" onClose={onClose}>
      {editing !== null ? (
        <StayForm
          initial={
            editing >= 0
              ? stays[editing]
              : prefillCheckIn
                ? { checkInDay: prefillCheckIn, checkOutDay: nextDay(prefillCheckIn) }
                : {}
          }
          onSubmit={(form) => {
            const next = [...stays]
            if (editing >= 0) next[editing] = form
            else next.push(form)
            save(next)
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <>
          {sorted.length === 0 && (
            <p className="muted hotel-stays-empty">
              No hotel stays yet{canEdit ? ' — add your first booking below.' : '.'}
            </p>
          )}
          <ul className="hotel-stay-list">
            {sorted.map(({ stay, index }) => (
              <li key={index} className="hotel-stay-card">
                <div className="hotel-stay-info">
                  <StayInfo stay={stay} />
                </div>
                {canEdit && (
                  <div className="hotel-stay-actions">
                    <button
                      type="button"
                      className="btn-icon"
                      title="Edit stay"
                      aria-label={`Edit stay at ${stay.hotelName}`}
                      onClick={() => setEditing(index)}
                    >
                      <PencilIcon />
                    </button>
                    <button
                      type="button"
                      className="btn-icon btn-icon-danger"
                      title="Delete stay"
                      aria-label={`Delete stay at ${stay.hotelName}`}
                      onClick={() => {
                        if (window.confirm(`Delete the stay at "${stay.hotelName}"?`))
                          save(stays.filter((_, i) => i !== index))
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
              Add Hotel Stay
            </button>
          )}
        </>
      )}
    </Modal>
  )
}

// Single stay opened from a day's check-in/check-out icon.
export function HotelStayDetail({ stay, onClose }) {
  return (
    <Modal title={stay.hotelName} onClose={onClose}>
      <div className="hotel-stay-info hotel-stay-detail">
        <div className="hotel-stay-dates">{formatStayRange(stay)}</div>
        <ConfirmationNumber value={stay.confirmationNumber} />
        {stay.hotelAddress ? (
          <a
            className="hotel-stay-address"
            href={mapsSearchUrl(stay.hotelAddress)}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in Google Maps"
          >
            {stay.hotelAddress}
          </a>
        ) : (
          <p className="muted">No address on file.</p>
        )}
      </div>
    </Modal>
  )
}
