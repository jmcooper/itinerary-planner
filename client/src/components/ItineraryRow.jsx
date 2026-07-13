import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { formatTimeBlock, parseTimeInput } from '../lib/time.js'
import ItemImages from './ItemImages.jsx'

export default function ItineraryRow({ tripId, item, canEdit, onSave }) {
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
        <span className="itin-time">{formatTimeBlock(item)}</span>
        <span className="itin-plan">{item.title}</span>
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
                    <ReactMarkdown>{item.description}</ReactMarkdown>
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

function ItemEditForm({ item, onSave, onCancel }) {
  const [start, setStart] = useState(item.timeLabel ?? (item.timeStart ? formatTimeBlock({ timeStart: item.timeStart }) : ''))
  const [end, setEnd] = useState(item.timeEnd ? formatTimeBlock({ timeStart: item.timeEnd }) : '')
  const [title, setTitle] = useState(item.title)
  const [description, setDescription] = useState(item.description)
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
