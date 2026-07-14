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

function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="btn-icon hotel-copy-btn"
      title={label}
      aria-label={label}
      onClick={() => {
        navigator.clipboard?.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? '✓' : <CopyIcon />}
    </button>
  )
}

// showEmpty renders a muted placeholder when there's no number on file —
// used in the detail modal so its absence is explicit, not a mystery.
// The whole pill is a button: clicking anywhere on it copies the number.
function ConfirmationNumber({ value, showEmpty = false }) {
  const [copied, setCopied] = useState(false)
  if (!value) {
    return showEmpty ? <p className="muted hotel-stay-no-conf">No confirmation # on file.</p> : null
  }
  return (
    <div className="hotel-stay-conf-row">
      <button
        type="button"
        className="hotel-stay-conf-pill"
        title="Copy confirmation number"
        aria-label={`Copy confirmation number ${value}`}
        onClick={() => {
          navigator.clipboard?.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        <span className="hotel-stay-conf-label">Confirmation #</span>
        <span className="hotel-stay-conf">
          {value}
          <span className="hotel-stay-conf-copy" aria-hidden="true">
            {copied ? '✓' : <CopyIcon />}
          </span>
        </span>
      </button>
    </div>
  )
}

// Maps link plus a copy button — the raw address is handy for Uber & co.
function StayAddress({ address }) {
  if (!address) return null
  return (
    <div className="hotel-stay-address-row">
      <a
        className="hotel-stay-address"
        href={mapsSearchUrl(address)}
        target="_blank"
        rel="noopener noreferrer"
        title="Open in Google Maps"
      >
        {address}
      </a>
      <CopyButton text={address} label="Copy address" />
    </div>
  )
}

function StayInfo({ stay }) {
  return (
    <>
      <div className="hotel-stay-name">{stay.hotelName}</div>
      <div className="hotel-stay-dates">{formatStayRange(stay)}</div>
      <ConfirmationNumber value={stay.confirmationNumber} />
      <StayAddress address={stay.hotelAddress} />
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

function StayForm({ initial, onSubmit, onCancel, hint = null }) {
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
      {hint && <p className="hotel-stay-hint">{hint}</p>}
    </form>
  )
}

// Add/view/edit all of a trip's hotel stays. onSave receives the full
// replacement array (stays live at the trip level).
export function HotelStaysModal({
  stays,
  canEdit,
  onSave,
  onClose,
  initialAdd = false,
  prefillCheckIn = null,
  chatAvailable = false,
}) {
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
          // Nudge toward the conversational path, but only for new stays.
          hint={
            editing === -1 && chatAvailable
              ? 'Tip: you can also ask the travel agent — e.g. “Add a hotel stay at the Holiday Inn, checking in July 18 and out July 21.”'
              : null
          }
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
        <ConfirmationNumber value={stay.confirmationNumber} showEmpty />
        {stay.hotelAddress ? (
          <StayAddress address={stay.hotelAddress} />
        ) : (
          <p className="muted">No address on file.</p>
        )}
      </div>
    </Modal>
  )
}
