import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { stripCodeFromHeadings } from '../lib/parse.js'

export default function ItineraryRow({ item, onSave }) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)

  return (
    <li className={`itin-row${expanded ? ' expanded' : ''}`}>
      <button
        type="button"
        className="itin-row-line"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="itin-time">{item.time}</span>
        <span className="itin-plan">{item.plan}</span>
        <span className="itin-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="itin-details">
          {editing ? (
            <ItemEditForm
              item={item}
              onCancel={() => setEditing(false)}
              onSave={async (updated) => {
                await onSave(updated)
                setEditing(false)
              }}
            />
          ) : (
            <>
              {item.details ? (
                <div className="markdown">
                  <ReactMarkdown>{stripCodeFromHeadings(item.details)}</ReactMarkdown>
                </div>
              ) : (
                <p className="muted">No details for this item yet.</p>
              )}
              <button type="button" className="btn btn-ghost btn-small" onClick={() => setEditing(true)}>
                Edit
              </button>
            </>
          )}
        </div>
      )}
    </li>
  )
}

function ItemEditForm({ item, onSave, onCancel }) {
  const [time, setTime] = useState(item.time)
  const [plan, setPlan] = useState(item.plan)
  const [details, setDetails] = useState(item.details)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!plan.trim()) return setError('The plan title cannot be empty.')
    setSaving(true)
    setError('')
    try {
      await onSave({ ...item, time: time.trim(), plan: plan.trim(), details })
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <form className="item-edit-form" onSubmit={handleSubmit}>
      <div className="item-edit-row">
        <label>
          Time
          <input type="text" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <label className="grow">
          Plan
          <input type="text" value={plan} onChange={(e) => setPlan(e.target.value)} />
        </label>
      </div>
      <label>
        Details (markdown)
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={10} spellCheck={false} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary btn-small" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
