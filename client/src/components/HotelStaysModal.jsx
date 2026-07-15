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

// The whole pill is a button: clicking anywhere on it copies the number.
function ConfirmationPill({ value }) {
  const [copied, setCopied] = useState(false)
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

function RoomList({ rooms }) {
  if (!rooms?.length) return null
  return (
    <ul className="hotel-stay-rooms">
      {rooms.map((room, i) => (
        <li key={i}>
          <span className="hotel-stay-room-type">{room.roomType || 'Room'}</span>
          {room.guests && <span> — {room.guests}</span>}
          {room.notes && <span className="muted"> · {room.notes}</span>}
        </li>
      ))}
    </ul>
  )
}

// One pill per confirmation, its rooms listed beneath. showEmpty renders a
// muted placeholder when nothing is on file (detail modal only).
function ConfirmationList({ stay, showEmpty = false }) {
  const confirmations = stay.confirmations ?? []
  if (!confirmations.length) {
    return showEmpty ? <p className="muted hotel-stay-no-conf">No confirmation # on file.</p> : null
  }
  return confirmations.map((conf, i) => (
    <div key={i} className="hotel-stay-conf-group">
      <ConfirmationPill value={conf.confirmationNumber} />
      <RoomList rooms={conf.rooms} />
    </div>
  ))
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
      <ConfirmationList stay={stay} />
      <StayAddress address={stay.hotelAddress} />
      {stay.linkedTripName && (
        <p className="muted hotel-stay-source">From “{stay.linkedTripName}” via a linked day</p>
      )}
    </>
  )
}

const EMPTY_FORM = { hotelName: '', hotelAddress: '', checkInDay: '', checkOutDay: '' }
const EMPTY_ROOM = { roomType: '', guests: '', notes: '' }

// Editable confirmation blocks, each with its nested room rows. Controlled:
// parent owns the array, this renders inputs and add/remove buttons.
function ConfirmationsEditor({ confirmations, onChange }) {
  const update = (i, patch) =>
    onChange(confirmations.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  const setRoomField = (i, r, field, value) =>
    update(i, {
      rooms: confirmations[i].rooms.map((room, idx) =>
        idx === r ? { ...room, [field]: value } : room
      ),
    })
  return (
    <div className="conf-editor">
      <span className="conf-editor-title">Confirmations</span>
      {confirmations.map((conf, i) => (
        <fieldset key={i} className="conf-block">
          <div className="conf-block-head">
            <label>
              Confirmation #
              <input
                type="text"
                value={conf.confirmationNumber}
                onChange={(e) => update(i, { confirmationNumber: e.target.value })}
              />
            </label>
            <button
              type="button"
              className="btn-icon btn-icon-danger"
              title="Remove confirmation"
              aria-label={`Remove confirmation ${conf.confirmationNumber || i + 1}`}
              onClick={() => onChange(confirmations.filter((_, idx) => idx !== i))}
            >
              <TrashIcon />
            </button>
          </div>
          {conf.rooms.map((room, r) => (
            <div key={r} className="conf-room">
              <input
                type="text"
                placeholder="Room type"
                aria-label="Room type"
                value={room.roomType}
                onChange={(e) => setRoomField(i, r, 'roomType', e.target.value)}
              />
              <input
                type="text"
                placeholder="Guests"
                aria-label="Guests"
                value={room.guests}
                onChange={(e) => setRoomField(i, r, 'guests', e.target.value)}
              />
              <input
                type="text"
                placeholder="Notes"
                aria-label="Notes"
                value={room.notes}
                onChange={(e) => setRoomField(i, r, 'notes', e.target.value)}
              />
              <button
                type="button"
                className="btn-icon btn-icon-danger"
                title="Remove room"
                aria-label={`Remove room ${r + 1}`}
                onClick={() => update(i, { rooms: conf.rooms.filter((_, idx) => idx !== r) })}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-link conf-add-btn"
            onClick={() => update(i, { rooms: [...conf.rooms, { ...EMPTY_ROOM }] })}
          >
            + Add room
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="btn btn-link conf-add-btn"
        onClick={() => onChange([...confirmations, { confirmationNumber: '', rooms: [] }])}
      >
        + Add confirmation
      </button>
    </div>
  )
}

function StayForm({ initial, onSubmit, onCancel, hint = null }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const [confirmations, setConfirmations] = useState(() =>
    (initial?.confirmations ?? []).map((c) => ({
      confirmationNumber: c.confirmationNumber,
      rooms: (c.rooms ?? []).map((room) => ({ ...EMPTY_ROOM, ...room })),
    }))
  )
  const [error, setError] = useState('')
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }))

  function handleSubmit(e) {
    e.preventDefault()
    const stay = {
      hotelName: form.hotelName,
      hotelAddress: form.hotelAddress,
      checkInDay: form.checkInDay,
      checkOutDay: form.checkOutDay,
      confirmations: confirmations.map((c) => ({
        confirmationNumber: c.confirmationNumber.trim(),
        // Drop rooms left entirely blank (stray "+ Add room" clicks), then
        // drop blank fields within each kept room.
        rooms: c.rooms
          .filter((room) => room.roomType.trim() || room.guests.trim() || room.notes.trim())
          .map((room) =>
            Object.fromEntries(
              Object.entries(room)
                .map(([k, v]) => [k, v.trim()])
                .filter(([, v]) => v)
            )
          ),
      })),
    }
    const problem = validateStay(stay)
    if (problem) return setError(problem)
    onSubmit(stay)
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
      <ConfirmationsEditor confirmations={confirmations} onChange={setConfirmations} />
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
  linkedStays = [], // read-only: owned by trips linked from here
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
  // Own stays are editable (index refers into `stays`); linked ones are not.
  const sorted = [
    ...stays.map((stay, index) => ({ stay, index })),
    ...linkedStays.map((stay) => ({ stay, index: null })),
  ]
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
            {sorted.map(({ stay, index }, i) => (
              <li key={index ?? `linked-${i}`} className="hotel-stay-card">
                <div className="hotel-stay-info">
                  <StayInfo stay={stay} />
                </div>
                {canEdit && index !== null && (
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

// Single stay opened from a day's check-in/check-out icon. Own stays can be
// edited in place; linked stays are read-only (they belong to the linked trip).
export function HotelStayDetail({ stay, canEdit = false, onSave, onClose }) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')

  async function save(form) {
    setError('')
    try {
      await onSave(form)
      setEditing(false)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <Modal title={stay.hotelName} onClose={onClose}>
      {editing ? (
        <>
          <StayForm initial={stay} onSubmit={save} onCancel={() => setEditing(false)} />
          {error && <p className="error">{error}</p>}
        </>
      ) : (
        <div className="hotel-stay-info hotel-stay-detail">
          <div className="hotel-stay-detail-head">
            <div className="hotel-stay-dates">{formatStayRange(stay)}</div>
            {canEdit && (
              <button
                type="button"
                className="btn-icon"
                title="Edit stay"
                aria-label={`Edit stay at ${stay.hotelName}`}
                onClick={() => setEditing(true)}
              >
                <PencilIcon />
              </button>
            )}
          </div>
          <ConfirmationList stay={stay} showEmpty />
          {stay.hotelAddress ? (
            <StayAddress address={stay.hotelAddress} />
          ) : (
            <p className="muted">No address on file.</p>
          )}
          {stay.linkedTripName && (
            <p className="muted hotel-stay-source">From “{stay.linkedTripName}” via a linked day</p>
          )}
        </div>
      )}
    </Modal>
  )
}
