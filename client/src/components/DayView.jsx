import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { formatDay } from '../lib/dates.js'
import { buildDayItems } from '../lib/parse.js'
import { convertImportItems, insertItemByTime } from '../lib/time.js'
import ItineraryRow, { ItemEditForm } from './ItineraryRow.jsx'
import { PencilIcon, TrashIcon, CheckInIcon, CheckOutIcon } from './icons.jsx'

export default function DayView({
  tripId,
  date,
  dayIndex,
  day,
  canEdit,
  onSaveDay,
  onDeleteDay,
  checkInStays = [],
  checkOutStays = [],
  missingStay = false,
  onOpenStay,
  onAddStay,
  onSetHotelNotNeeded,
  onLinkDay,
  onUnlinkDay,
}) {
  const [linking, setLinking] = useState(false)
  const { weekday, label, year } = formatDay(date)
  const heading = `Day ${dayIndex + 1} — ${weekday}, ${label}, ${year}`
  const items = day.items ?? []
  const onSaveItems = (nextItems) => onSaveDay({ items: nextItems })
  const isLinked = Boolean(day.linkedTripId)
  // Editing a linked day writes through to the target trip, so it also
  // requires edit rights there.
  const dayCanEdit = canEdit && (!isLinked || day.linkedCanEdit === true)
  // Images on a linked day's items live in the target trip's image store.
  const imagesTripId = isLinked && !day.linkedBroken ? day.linkedTripId : tripId
  const needsHotel = missingStay && !day.hotelNotNeeded
  // Check-out icons render before check-in icons by design.
  const hotelMarks = [
    ...checkOutStays.map((stay) => ({ stay, out: true })),
    ...checkInStays.map((stay) => ({ stay, out: false })),
  ]
  const linkAction =
    dayCanEdit && onLinkDay && !isLinked ? (
      <button type="button" className="quiet-toggle" onClick={() => setLinking(true)}>
        Link to another itinerary
      </button>
    ) : null

  function handleDelete() {
    if (
      !window.confirm(
        `Delete Day ${dayIndex + 1} (${weekday}, ${label})? Its itinerary will be removed; other days keep their dates.`
      )
    )
      return
    onDeleteDay()
  }

  return (
    <div className="day-view">
      <div className="day-header">
        <div>
          <div className="day-title-row">
            <h2 className={`day-title${needsHotel ? ' missing-stay' : ''}`}>{heading}</h2>
            {hotelMarks.map(({ stay, out }, i) => (
              <button
                key={i}
                type="button"
                className={`btn-icon day-hotel-icon ${out ? 'hotel-icon-checkout' : 'hotel-icon-checkin'}`}
                title={`${out ? 'Check out of' : 'Check in to'} ${stay.hotelName}`}
                aria-label={`${out ? 'Check out of' : 'Check in to'} ${stay.hotelName}`}
                onClick={() => onOpenStay?.(stay)}
              >
                {out ? <CheckOutIcon size={25} /> : <CheckInIcon size={25} />}
              </button>
            ))}
          </div>
          <DayTitle title={day.title ?? ''} canEdit={dayCanEdit} onSave={(title) => onSaveDay({ title })} />
        </div>
        <MapsLink
          mapsUrl={day.mapsUrl ?? ''}
          canEdit={dayCanEdit}
          onSave={(mapsUrl) => onSaveDay({ mapsUrl })}
        />
      </div>
      {isLinked && (
        <div className="linked-day-note">
          {day.linkedBroken ? (
            <span>
              Linked itinerary
              {day.linkedTripName ? ` “${day.linkedTripName}”` : ''} is unavailable.
            </span>
          ) : (
            <span>
              Linked to <Link to={`/trips/${day.linkedTripId}`}>{day.linkedTripName}</Link>
            </span>
          )}
          {canEdit && onUnlinkDay && (
            <button
              type="button"
              className="quiet-toggle"
              onClick={() => {
                if (window.confirm('Unlink this day? It becomes an empty day here; the linked trip keeps its itinerary.'))
                  onUnlinkDay()
              }}
            >
              Unlink
            </button>
          )}
        </div>
      )}
      {linking ? (
        <div className="day-add-item">
          <LinkDayForm
            tripId={tripId}
            date={date}
            onLink={async (targetId) => {
              await onLinkDay(targetId)
              setLinking(false)
            }}
            onCancel={() => setLinking(false)}
          />
        </div>
      ) : (
        <>
          {needsHotel ? (
            <div className="hotel-warning">
              <span>No hotel stay covers this night.</span>
              {canEdit && (
                <span className="hotel-warning-actions">
                  <button type="button" className="btn btn-ghost btn-small" onClick={onAddStay}>
                    Add hotel stay
                  </button>
                  {dayCanEdit && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      onClick={() => onSetHotelNotNeeded?.(true)}
                    >
                      Hotel stay not needed this day
                    </button>
                  )}
                </span>
              )}
            </div>
          ) : day.hotelNotNeeded ? (
            <p className="hotel-not-needed-note muted">
              No hotel needed this night.
              {dayCanEdit && (
                <button type="button" className="btn btn-link" onClick={() => onSetHotelNotNeeded?.(false)}>
                  Undo
                </button>
              )}
            </p>
          ) : null}
          {items.length === 0 ? (
            dayCanEdit ? (
              <>
                <EmptyDayEditor onSaveItems={onSaveItems} />
                {linkAction && <p className="day-link-row">{linkAction}</p>}
                {onDeleteDay && (
                  <div className="day-table-footer">
                    <DeleteDayButton onClick={handleDelete} />
                  </div>
                )}
              </>
            ) : (
              <p className="empty-note">No itinerary for this day yet.</p>
            )
          ) : (
            <DayTable
              tripId={imagesTripId}
              items={items}
              canEdit={dayCanEdit}
              onSaveItems={onSaveItems}
              onDeleteDay={canEdit && onDeleteDay ? handleDelete : null}
              linkAction={linkAction}
            />
          )}
        </>
      )}
    </div>
  )
}

function DeleteDayButton({ onClick }) {
  return (
    <button type="button" className="btn btn-ghost btn-danger-outline" onClick={onClick}>
      Delete Day
    </button>
  )
}

function DayTitle({ title, canEdit, onSave }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  if (editing) {
    return (
      <form
        className="day-subtitle-form"
        onSubmit={async (e) => {
          e.preventDefault()
          setSaving(true)
          try {
            await onSave(value.trim())
            setEditing(false)
          } finally {
            setSaving(false)
          }
        }}
      >
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Day title, e.g. West side geysers"
          aria-label="Day title"
          autoFocus
        />
        <button type="submit" className="btn btn-primary btn-small" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </form>
    )
  }

  if (!title && !canEdit) return null
  return (
    <p className="day-subtitle">
      {title || <span className="muted">No day title</span>}
      {canEdit && (
        <button
          type="button"
          className="btn-icon"
          onClick={() => {
            setValue(title)
            setEditing(true)
          }}
          title="Edit day title"
          aria-label="Edit day title"
        >
          <PencilIcon />
        </button>
      )}
    </p>
  )
}

function MapsLink({ mapsUrl, canEdit, onSave }) {
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  function startEditing() {
    setUrl(mapsUrl)
    setError('')
    setEditing(true)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = url.trim()
    if (trimmed && !/^https?:\/\//i.test(trimmed))
      return setError('The link must start with http:// or https://')
    setSaving(true)
    setError('')
    try {
      await onSave(trimmed)
      setEditing(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <form className="maps-link-form" onSubmit={handleSubmit} noValidate>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a Google Maps link"
          aria-label="Google Maps link"
          autoFocus
        />
        <button type="submit" className="btn btn-primary btn-small" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => setEditing(false)}>
          Cancel
        </button>
        {error && <p className="error maps-link-error">{error}</p>}
      </form>
    )
  }

  if (mapsUrl) {
    return (
      <div className="maps-link">
        <a href={mapsUrl} target="_blank" rel="noopener noreferrer">
          Itinerary Map Link
        </a>
        {canEdit && (
          <>
            <button
              type="button"
              className="btn-icon"
              onClick={startEditing}
              title="Edit maps link"
              aria-label="Edit maps link"
            >
              <PencilIcon />
            </button>
            <button
              type="button"
              className="btn-icon btn-icon-danger"
              onClick={() => onSave('')}
              title="Remove maps link"
              aria-label="Remove maps link"
            >
              <TrashIcon />
            </button>
          </>
        )}
      </div>
    )
  }

  if (!canEdit) return null
  return (
    <button type="button" className="btn btn-ghost btn-small" onClick={startEditing}>
      Add Maps Link
    </button>
  )
}

const newItem = () => ({
  timeStart: null,
  timeEnd: null,
  timeLabel: null,
  title: '',
  description: '',
  travel: false,
  imageIds: [],
})

// Empty-day editor: items are added one at a time; the legacy CSV/markdown
// paste flow stays available behind a quiet link.
function EmptyDayEditor({ onSaveItems }) {
  const [mode, setMode] = useState('menu') // 'menu' | 'add' | 'paste'

  if (mode === 'paste') {
    return (
      <>
        <DayImportForm onSave={onSaveItems} />
        <p className="quiet-toggle-row">
          <button type="button" className="quiet-toggle" onClick={() => setMode('menu')}>
            Back to adding items one at a time
          </button>
        </p>
      </>
    )
  }
  if (mode === 'add') {
    return (
      <div className="day-add-item">
        <ItemEditForm
          item={newItem()}
          onSave={(item) => onSaveItems([item])}
          onCancel={() => setMode('menu')}
          extraActions={
            <button type="button" className="quiet-toggle" onClick={() => setMode('paste')}>
              Use old CSV flow
            </button>
          }
        />
      </div>
    )
  }
  return (
    <div className="empty-day-editor">
      <p className="muted">This day has no itinerary yet.</p>
      <button type="button" className="btn btn-primary" onClick={() => setMode('add')}>
        Add Itinerary Item
      </button>
    </div>
  )
}

function DayImportForm({ onSave }) {
  const [csv, setCsv] = useState('')
  const [details, setDetails] = useState('')
  const [warnings, setWarnings] = useState([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    const { items, warnings: w } = buildDayItems(csv, details)
    if (items.length === 0) {
      setError('No itinerary lines found — paste CSV like: 8:00 am,Leave hotel,S1')
      setWarnings(w)
      return
    }
    setWarnings(w)
    setSaving(true)
    try {
      await onSave(convertImportItems(items))
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <form className="import-form" onSubmit={handleSubmit}>
      <p className="muted">
        This day has no itinerary yet. Paste the day’s CSV (<code>Time,Plan,Detail</code>) and the
        matching details markdown (<code>## S1 — Title</code> sections separated by{' '}
        <code>---</code>).
      </p>
      <div className="import-grid">
        <label>
          Itinerary CSV
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={'Time,Plan,Detail\n8:00 am,Leave Holiday Inn West Yellowstone,S1\n8:05–8:40,Enter park and drive to Madison Junction,S2'}
            rows={12}
            spellCheck={false}
          />
        </label>
        <label>
          Itinerary details (markdown)
          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder={'## S1 — Leave Holiday Inn West Yellowstone\n\nLeave at **8:00 am** from…\n\n---\n\n## S2 — Enter park and drive to Madison Junction\n\n…'}
            rows={12}
            spellCheck={false}
          />
        </label>
      </div>
      {warnings.map((w) => (
        <p key={w} className="warning">{w}</p>
      ))}
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Create Day Itinerary'}
        </button>
      </div>
    </form>
  )
}

function DayTable({ tripId, items, canEdit, onSaveItems, onDeleteDay, linkAction = null }) {
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)

  async function saveItem(index, updated) {
    const next = items.map((item, i) => (i === index ? updated : item))
    await onSaveItems(next)
  }

  async function deleteItem(index) {
    if (!window.confirm(`Delete "${items[index].title}" from this day?`)) return
    try {
      await onSaveItems(items.filter((_, i) => i !== index))
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="day-table-wrap">
      {error && <p className="error">{error}</p>}
      <ul className="day-table">
        {items.map((item, index) => (
          <ItineraryRow
            key={`${index}-${item.title}`}
            tripId={tripId}
            item={item}
            canEdit={canEdit}
            onSave={(u) => saveItem(index, u)}
            onDelete={() => deleteItem(index)}
          />
        ))}
      </ul>
      {adding && (
        <div className="day-add-item">
          <ItemEditForm
            item={newItem()}
            onSave={async (item) => {
              // New items slot into chronological position by start time.
              await onSaveItems(insertItemByTime(items, item))
              setAdding(false)
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}
      {canEdit && linkAction && <p className="day-link-row">{linkAction}</p>}
      {canEdit && (
        <div className="day-table-footer">
          {onDeleteDay && <DeleteDayButton onClick={onDeleteDay} />}
          {!adding && (
            <button
              type="button"
              className="btn btn-ghost btn-success-outline"
              onClick={() => setAdding(true)}
            >
              Add Itinerary Item
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// Replaces the edit dialog when "Link to another itinerary" is clicked: a
// dropdown of the user's other trips, filtered to those that also contain
// this date. Linking stores only a marker here — the selected trip's day
// stays the single source of truth.
function LinkDayForm({ tripId, date, onLink, onCancel }) {
  const [options, setOptions] = useState(null) // null = loading
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const { weekday, label } = formatDay(date)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const lists = await api.listTrips()
        const candidates = [...lists.mine, ...lists.shared].filter((t) => t.id !== tripId)
        const withDate = []
        for (const candidate of candidates) {
          try {
            const full = await api.getTrip(candidate.id)
            const target = full.days?.[date]
            // Only trips that contain this date; linked days can't chain.
            if (target && !target.linkedTripId) withDate.push({ id: full.id, name: full.name })
          } catch {
            // skip trips that fail to load
          }
        }
        if (cancelled) return
        setOptions(withDate)
        setSelected(withDate[0]?.id ?? '')
      } catch (err) {
        if (cancelled) return
        setError(err.message)
        setOptions([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tripId, date])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!selected) return
    setSaving(true)
    setError('')
    try {
      await onLink(selected)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <form className="link-day-form" onSubmit={handleSubmit}>
      {options === null ? (
        <p className="muted">Finding trips that include {weekday}, {label}…</p>
      ) : options.length === 0 ? (
        <p className="muted">None of your other trips include {weekday}, {label}.</p>
      ) : (
        <>
          <label className="link-day-select">
            Link this day to
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <p className="muted link-day-note">
            This day will show that trip's itinerary for {weekday}, {label}. Edits made here
            update that trip directly.
          </p>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        {options !== null && options.length > 0 && (
          <button type="submit" className="btn btn-primary btn-small" disabled={saving || !selected}>
            {saving ? 'Linking…' : 'Link Day'}
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
