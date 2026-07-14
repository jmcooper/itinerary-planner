import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api.js'
import { listDates, listTripDates, formatDay, formatRange } from '../lib/dates.js'
import DayView from '../components/DayView.jsx'
import SharePanel from '../components/SharePanel.jsx'
import ChatPanel from '../components/ChatPanel.jsx'
import { HotelStaysModal, HotelStayDetail } from '../components/HotelStaysModal.jsx'
import { GearIcon, CheckInIcon, CheckOutIcon } from '../components/icons.jsx'
import { checkInsOn, checkOutsOn, isMissingStay } from '../lib/hotels.js'

export default function TripPage() {
  const { id } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const initialPrompt = location.state?.initialPrompt ?? null
  const initialModel = location.state?.model ?? null
  const [trip, setTrip] = useState(null)
  const [ai, setAi] = useState({ enabled: false, models: [] })
  const [error, setError] = useState('')
  const [selectedDate, setSelectedDate] = useState(null)
  const [editingDates, setEditingDates] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // null | {type:'list'} | {type:'add', prefillCheckIn} | {type:'stay', stay}
  const [hotelModal, setHotelModal] = useState(null)
  const [mobileView, setMobileView] = useState(initialPrompt ? 'chat' : 'itinerary')
  const [chatBusy, setChatBusy] = useState(Boolean(initialPrompt))

  useEffect(() => {
    api
      .getTrip(id)
      .then((t) => {
        setTrip(t)
        const dates = listTripDates(t)
        if (dates.length > 0) setSelectedDate(dates[0])
      })
      .catch((err) => setError(err.message))
    api
      .aiStatus()
      .then(setAi)
      .catch(() => setAi({ enabled: false, models: [] }))
  }, [id])

  async function saveTrip(patch) {
    const updated = await api.updateTrip(id, patch)
    setTrip(updated)
    // Changing the slug changes the trip's URL — follow it.
    if (updated.id !== id) navigate(`/trips/${updated.id}`, { replace: true })
    return updated
  }

  // Called when the assistant writes to the trip mid-stream.
  async function refreshTrip() {
    try {
      const t = await api.getTrip(id)
      setTrip(t)
      setSelectedDate((current) => {
        const dates = listTripDates(t)
        return current && dates.includes(current) ? current : dates[0] ?? null
      })
    } catch {
      // transient refresh failures are non-fatal; the next event retries
    }
  }

  // Saves a patch onto one day. Linked days write through to the target trip
  // (the marker stored here is untouched — the target stays the single
  // source of truth); plain days merge into this trip as usual.
  async function saveDay(date, patch) {
    const current = trip.days?.[date] ?? {}
    const merged = { ...current, ...patch }
    if (!merged.hotelNotNeeded) delete merged.hotelNotNeeded
    if (current.linkedTripId && !current.linkedBroken) {
      const { linkedTripId, linkedTripName, linkedCanEdit, linkedBroken, linkedHotelStays, ...content } = merged
      const target = await api.getTrip(current.linkedTripId)
      await api.updateTrip(target.id, { days: { ...target.days, [date]: content } })
      await refreshTrip() // re-resolve the link
      return
    }
    await saveTrip({ days: { ...trip.days, [date]: merged } })
  }

  // The day-level "no hotel needed this night" flag rides inside the day entry.
  const setHotelNotNeeded = (date, flag) => saveDay(date, { hotelNotNeeded: flag })

  const linkedTripIds = [
    ...new Set(
      Object.values(trip?.days ?? {})
        .map((d) => d.linkedTripId)
        .filter(Boolean)
    ),
  ]

  // Grants the given users / public visibility on a linked trip so everyone
  // who can see this trip can see the days it links to. Only the owner of
  // the linked trip can change its sharing; others are skipped.
  async function propagateSharing(targetTripId, { users = [], makePublic = false }) {
    try {
      const target = await api.getTrip(targetTripId)
      if (!target.isOwner) return
      const patch = {}
      if (makePublic && target.visibility !== 'public') patch.visibility = 'public'
      const missing = users.filter(
        (u) => u !== target.ownerId && !(target.sharedWith ?? []).includes(u)
      )
      if (missing.length) patch.sharedWith = [...(target.sharedWith ?? []), ...missing]
      if (Object.keys(patch).length) await api.updateTrip(targetTripId, patch)
    } catch {
      // a linked trip we can't read or update keeps its own sharing
    }
  }

  // Wraps saveTrip for the settings panel: sharing changes extend to linked
  // trips (after a confirmation) so shared viewers can see the linked days.
  async function saveTripSharingAware(patch) {
    const addedUsers = (patch.sharedWith ?? []).filter(
      (u) => !(trip.sharedWith ?? []).includes(u)
    )
    const goingPublic = patch.visibility === 'public' && trip.visibility !== 'public'
    if (linkedTripIds.length > 0 && (addedUsers.length > 0 || goingPublic)) {
      const message = goingPublic
        ? 'Days in this trip are linked to other itineraries. Making this trip public will also make those itineraries public. Continue?'
        : 'Days in this trip are linked to other itineraries. Those itineraries will also be shared with the selected user. Continue?'
      if (!window.confirm(message)) return trip
      const updated = await saveTrip(patch)
      for (const id of linkedTripIds) {
        await propagateSharing(id, { users: addedUsers, makePublic: goingPublic })
      }
      return updated
    }
    return saveTrip(patch)
  }

  // Linking stores only a marker; unlinking restores a plain empty day (the
  // linked trip keeps its itinerary either way). If this trip is already
  // shared or public, the newly linked trip is shared the same way (after a
  // confirmation) so viewers of this trip can see the linked day.
  async function linkDay(date, targetTripId) {
    const sharedUsers = trip.sharedWith ?? []
    const isPublicTrip = trip.visibility === 'public'
    if (sharedUsers.length > 0 || isPublicTrip) {
      const message = isPublicTrip
        ? 'This trip is public. The itinerary you link to will be made public as well. Continue?'
        : 'This trip is shared. The itinerary you link to will be shared with the same people. Continue?'
      if (!window.confirm(message)) return false
    }
    await saveTrip({ days: { ...trip.days, [date]: { linkedTripId: targetTripId } } })
    if (sharedUsers.length > 0 || isPublicTrip) {
      await propagateSharing(targetTripId, { users: sharedUsers, makePublic: isPublicTrip })
    }
    return true
  }
  const unlinkDay = (date) =>
    saveTrip({ days: { ...trip.days, [date]: { title: '', mapsUrl: '', items: [] } } })

  // Removes a day entirely; remaining days keep their dates (gaps are fine).
  async function deleteDay(date) {
    const { [date]: _removed, ...remainingDays } = trip.days ?? {}
    const updated = await saveTrip({ days: remainingDays })
    const remaining = listTripDates(updated)
    const next = remaining.find((d) => d > date) ?? remaining[remaining.length - 1] ?? null
    setSelectedDate(next)
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

  const dates = listTripDates(trip)
  const canEdit = trip.canEdit ?? false
  const hotelStays = trip.hotelStays ?? []
  const showChat = ai.enabled && canEdit
  const awaitingFirstItinerary = showChat && chatBusy && dates.length === 0
  const needsDates = canEdit && !awaitingFirstItinerary && (dates.length === 0 || editingDates)
  // Legacy ownerless trips are public; owned trips default to private.
  const isPublic = trip.ownerId ? trip.visibility === 'public' : true

  // Stays carried in by ANY linked day participate trip-wide, so a stay's
  // check-out icon shows even when that date itself isn't linked (or is
  // linked elsewhere). Icons and coverage filter by date anyway. Deduped —
  // two days linked to the same trip both carry the same stay.
  const linkedStays = []
  const seenStays = new Set()
  for (const d of Object.values(trip.days ?? {})) {
    for (const stay of d.linkedHotelStays ?? []) {
      const key = `${stay.hotelName}|${stay.checkInDay}|${stay.checkOutDay}|${stay.confirmationNumber ?? ''}`
      if (seenStays.has(key)) continue
      seenStays.add(key)
      linkedStays.push(stay)
    }
  }
  const allStays = [...hotelStays, ...linkedStays]

  const itinerary = needsDates ? (
    <AddDaysForm
      onCancel={dates.length > 0 ? () => setEditingDates(false) : null}
      onSave={async (startDate, endDate) => {
        // Seed an (empty) day entry per date; existing days are untouched.
        const seeded = { ...(trip.days ?? {}) }
        for (const d of listDates(startDate, endDate)) {
          seeded[d] ??= { title: '', mapsUrl: '', items: [] }
        }
        const updated = await saveTrip({ days: seeded })
        setEditingDates(false)
        const newDates = listTripDates(updated)
        if (!newDates.includes(selectedDate)) setSelectedDate(newDates[0] ?? null)
      }}
    />
  ) : awaitingFirstItinerary ? (
    <SkeletonDays />
  ) : dates.length === 0 ? (
    <p className="empty-note">This trip has no dates yet.</p>
  ) : (
    <div className="trip-body">
      <aside className="day-nav" aria-label="Trip days">
        <ol>
          {dates.map((date, i) => {
            const { weekday, label } = formatDay(date)
            const hasItems = (trip.days?.[date]?.items?.length ?? 0) > 0
            const missing = isMissingStay(allStays, date) && !trip.days?.[date]?.hotelNotNeeded
            // Check-out icons render before check-in icons by design.
            const hotelMarks = [
              ...checkOutsOn(allStays, date).map((stay) => ({ stay, out: true })),
              ...checkInsOn(allStays, date).map((stay) => ({ stay, out: false })),
            ]
            return (
              <li key={date} className="day-nav-li">
                <button
                  type="button"
                  className={`day-nav-item${date === selectedDate ? ' selected' : ''}${missing ? ' missing-stay' : ''}`}
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
                {hotelMarks.length > 0 && (
                  <span className="day-nav-hotel-icons">
                    {hotelMarks.map(({ stay, out }, j) => (
                      <button
                        key={j}
                        type="button"
                        className={`day-nav-hotel-icon ${out ? 'hotel-icon-checkout' : 'hotel-icon-checkin'}`}
                        title={`${out ? 'Check out of' : 'Check in to'} ${stay.hotelName}`}
                        aria-label={`${out ? 'Check out of' : 'Check in to'} ${stay.hotelName}`}
                        onClick={() => setHotelModal({ type: 'stay', stay })}
                      >
                        {out ? <CheckOutIcon size={17} /> : <CheckInIcon size={17} />}
                      </button>
                    ))}
                  </span>
                )}
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
            canEdit={canEdit}
            day={trip.days?.[selectedDate] ?? {}}
            checkInStays={checkInsOn(allStays, selectedDate)}
            checkOutStays={checkOutsOn(allStays, selectedDate)}
            missingStay={isMissingStay(allStays, selectedDate)}
            onOpenStay={(stay) => setHotelModal({ type: 'stay', stay })}
            onAddStay={() => setHotelModal({ type: 'add', prefillCheckIn: selectedDate })}
            onSetHotelNotNeeded={(flag) => setHotelNotNeeded(selectedDate, flag)}
            onSaveDay={(patch) => saveDay(selectedDate, patch)}
            onLinkDay={(targetTripId) => linkDay(selectedDate, targetTripId)}
            onUnlinkDay={() => unlinkDay(selectedDate)}
            onDeleteDay={() => deleteDay(selectedDate)}
          />
        ) : (
          <p className="empty-note">Select a day on the left.</p>
        )}
      </section>
    </div>
  )

  return (
    <div className="trip">
      <div className="trip-header">
        <div>
          <nav className="breadcrumb">
            <Link to="/">Trips</Link> <span aria-hidden="true">/</span>
          </nav>
          <div className="trip-title-row">
            <h1>{trip.name}</h1>
            <span className={`visibility-badge${isPublic ? ' public' : ''}`}>
              {isPublic ? 'Public' : 'Private'}
            </span>
            {trip.archived && <span className="visibility-badge">Archived</span>}
            {trip.isOwner && (
              <button
                type="button"
                className={`btn-icon trip-settings-toggle${settingsOpen ? ' active' : ''}`}
                onClick={() => setSettingsOpen((v) => !v)}
                aria-expanded={settingsOpen}
                title="Trip settings"
                aria-label="Trip settings"
              >
                <GearIcon />
              </button>
            )}
          </div>
          <p className="trip-dates-line">
            {formatRange(dates[0], dates[dates.length - 1])}
            {dates.length > 0 && <span className="muted"> · {dates.length} day{dates.length === 1 ? '' : 's'}</span>}
            {canEdit && dates.length > 0 && !editingDates && (
              <button type="button" className="btn btn-link" onClick={() => setEditingDates(true)}>
                Add days
              </button>
            )}
            {dates.length > 0 && (canEdit || allStays.length > 0) && (
              <button type="button" className="btn btn-link" onClick={() => setHotelModal({ type: 'list' })}>
                Hotel stays{allStays.length > 0 ? ` (${allStays.length})` : ''}
              </button>
            )}
          </p>
          {trip.summary && <p className="trip-summary">{trip.summary}</p>}
        </div>
      </div>

      {trip.isOwner && settingsOpen && (
        <SharePanel trip={trip} onSave={saveTripSharingAware} onClose={() => setSettingsOpen(false)} />
      )}

      {(hotelModal?.type === 'list' || hotelModal?.type === 'add') && (
        <HotelStaysModal
          stays={hotelStays}
          linkedStays={linkedStays}
          canEdit={canEdit}
          initialAdd={hotelModal.type === 'add'}
          prefillCheckIn={hotelModal.prefillCheckIn ?? null}
          chatAvailable={showChat}
          onSave={(next) => saveTrip({ hotelStays: next })}
          onClose={() => setHotelModal(null)}
        />
      )}
      {hotelModal?.type === 'stay' && (
        <HotelStayDetail stay={hotelModal.stay} onClose={() => setHotelModal(null)} />
      )}

      {showChat && (
        <div className="trip-tabs" role="tablist" aria-label="Trip view">
          <button
            type="button"
            role="tab"
            aria-selected={mobileView === 'itinerary'}
            className={`trip-tab${mobileView === 'itinerary' ? ' active' : ''}`}
            onClick={() => setMobileView('itinerary')}
          >
            Itinerary
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileView === 'chat'}
            className={`trip-tab${mobileView === 'chat' ? ' active' : ''}`}
            onClick={() => setMobileView('chat')}
          >
            Travel Agent
          </button>
        </div>
      )}

      {showChat ? (
        <div className="trip-columns">
          <div className={`trip-main${mobileView === 'chat' ? ' mobile-hidden' : ''}`}>
            {itinerary}
          </div>
          <div className={`trip-chat${mobileView === 'itinerary' ? ' mobile-hidden' : ''}`}>
            <ChatPanel
              tripId={trip.id}
              models={ai.models}
              initialPrompt={initialPrompt}
              initialModel={initialModel}
              onTripChanged={refreshTrip}
              onBusyChange={setChatBusy}
            />
          </div>
        </div>
      ) : (
        itinerary
      )}
    </div>
  )
}

function SkeletonDays() {
  return (
    <div className="trip-body skeleton" aria-hidden="true">
      <aside className="day-nav">
        <ol>
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <div className="day-nav-item skeleton-bar" />
            </li>
          ))}
        </ol>
      </aside>
      <section className="day-panel">
        <div className="skeleton-bar skeleton-title" />
        <div className="skeleton-bar" />
        <div className="skeleton-bar" />
        <div className="skeleton-bar short" />
        <p className="muted skeleton-note">The assistant is drafting your itinerary…</p>
      </section>
    </div>
  )
}

function AddDaysForm({ onSave, onCancel }) {
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    const end = endDate || startDate // a single day needs no end date
    if (!startDate) return setError('Choose a start date.')
    if (end < startDate) return setError('The end date must be on or after the start date.')
    if (listDates(startDate, end).length > 60) return setError('Add at most 60 days at a time.')
    setSaving(true)
    setError('')
    try {
      await onSave(startDate, end)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <form className="date-range-form card" onSubmit={handleSubmit}>
      <h2>Add days</h2>
      <p className="muted">
        Pick a date or range to add — each day gets its own itinerary. Days you already have are
        left untouched.
      </p>
      <div className="date-range-inputs">
        <label>
          From
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
        </label>
        <span className="date-range-sep" aria-hidden="true">→</span>
        <label>
          Through (optional)
          <input type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Adding…' : 'Add Days'}
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
