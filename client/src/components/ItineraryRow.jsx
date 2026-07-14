import { useState } from 'react'
import { formatTimeBlock, formatDuration, parseTimeInput } from '../lib/time.js'
import Markdown from './Markdown.jsx'
import ItemImages from './ItemImages.jsx'

export default function ItineraryRow({ tripId, item, canEdit, onSave }) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const travelDuration = item.travel ? formatDuration(item) : ''

  return (
    <li className={`itin-row${item.travel ? ' travel' : ''}${expanded ? ' expanded' : ''}`}>
      <button
        type="button"
        className="itin-row-line"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {item.travel ? (
          <span className="itin-travel-label">
            {item.title}
            {travelDuration && <span className="itin-travel-duration"> · {travelDuration}</span>}
          </span>
        ) : (
          <>
            <span className="itin-time">{formatTimeBlock(item)}</span>
            <span className="itin-plan">{item.title}</span>
          </>
        )}
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
            <div className="itin-details-body">
              <div className="itin-details-main">
                {item.description ? (
                  <div className="markdown">
                    <Markdown>{item.description}</Markdown>
                  </div>
                ) : (
                  <p className="muted">No details for this item yet.</p>
                )}
                {canEdit && (
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => setEditing(true)}>
                    Edit
                  </button>
                )}
              </div>
              <ItemImages
                tripId={tripId}
                imageIds={item.imageIds ?? []}
                canEdit={canEdit}
                onChangeIds={(imageIds) => onSave({ ...item, imageIds })}
              />
            </div>
          )}
        </div>
      )}
    </li>
  )
}

// Also used by DayView to add new items (pass an empty item shape).
// extraActions renders at the far right of the Save/Cancel row.
export function ItemEditForm({ item, onSave, onCancel, extraActions = null }) {
  const [start, setStart] = useState(item.timeLabel ?? (item.timeStart ? formatTimeBlock({ timeStart: item.timeStart }) : ''))
  const [end, setEnd] = useState(item.timeEnd ? formatTimeBlock({ timeStart: item.timeEnd }) : '')
  const [title, setTitle] = useState(item.title)
  const [description, setDescription] = useState(item.description)
  const [travel, setTravel] = useState(item.travel === true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!title.trim()) return setError('The title cannot be empty.')
    const timeStart = parseTimeInput(start)
    const timeEnd = parseTimeInput(end)
    if (start.trim() && timeStart === null)
      return setError('Start time should look like “8:15 am” or “14:00”.')
    if (end.trim() && timeEnd === null)
      return setError('End time should look like “8:45 am” or “15:00”.')
    setSaving(true)
    setError('')
    try {
      await onSave({
        ...item,
        timeStart,
        timeEnd,
        timeLabel: null,
        title: title.trim(),
        description,
        travel,
      })
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <form className="item-edit-form" onSubmit={handleSubmit}>
      <div className="item-edit-row">
        <label>
          Start
          <input type="text" value={start} onChange={(e) => setStart(e.target.value)} placeholder="8:15 am" />
        </label>
        <label>
          End
          <input type="text" value={end} onChange={(e) => setEnd(e.target.value)} placeholder="8:45 am" />
        </label>
        <label className="grow">
          Title
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      <label>
        Details (markdown)
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={10} spellCheck={false} />
      </label>
      <label className="item-edit-travel">
        <input type="checkbox" checked={travel} onChange={(e) => setTravel(e.target.checked)} />
        Travel time — shows as a compact connector between events
      </label>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary btn-small" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>
          Cancel
        </button>
        {extraActions}
      </div>
    </form>
  )
}
