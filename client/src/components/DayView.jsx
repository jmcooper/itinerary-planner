import { useState } from 'react'
import { formatDay } from '../lib/dates.js'
import { buildDayItems } from '../lib/parse.js'
import ItineraryRow from './ItineraryRow.jsx'

export default function DayView({ date, dayIndex, items, onSaveItems }) {
  const { weekday, label, year } = formatDay(date)
  const heading = `Day ${dayIndex + 1} — ${weekday}, ${label}, ${year}`

  return (
    <div className="day-view">
      <h2 className="day-title">{heading}</h2>
      {items.length === 0 ? (
        <DayImportForm onSave={onSaveItems} />
      ) : (
        <DayTable items={items} onSaveItems={onSaveItems} />
      )}
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
      await onSave(items)
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

function DayTable({ items, onSaveItems }) {
  const [error, setError] = useState('')

  async function saveItem(index, updated) {
    const next = items.map((item, i) => (i === index ? updated : item))
    await onSaveItems(next)
  }

  async function handleClearDay() {
    if (!window.confirm('Clear this day and paste new CSV? The current items will be removed.'))
      return
    try {
      await onSaveItems([])
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="day-table-wrap">
      {error && <p className="error">{error}</p>}
      <ul className="day-table">
        {items.map((item, index) => (
          <ItineraryRow key={`${index}-${item.code}`} item={item} onSave={(u) => saveItem(index, u)} />
        ))}
      </ul>
      <div className="day-table-footer">
        <button type="button" className="btn btn-ghost btn-danger" onClick={handleClearDay}>
          Clear day &amp; re-paste
        </button>
      </div>
    </div>
  )
}
