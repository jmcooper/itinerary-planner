import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { filterUsernames } from '../lib/users.js'

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// Owner-only controls: trip rename, public/private toggle, plus a searchable
// dropdown of all usernames — click to browse, type to filter — with shared
// users shown as removable chips.
export default function SharePanel({ trip, onSave, onClose }) {
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState(trip.name)
  const [slug, setSlug] = useState(trip.id)
  const isPublic = trip.visibility === 'public'
  const sharedWith = trip.sharedWith ?? []
  const nameChanged = name.trim() !== trip.name && name.trim() !== ''
  const slugValue = slug.trim()
  const slugChanged = slugValue !== trip.id && slugValue !== ''
  const slugValid = SLUG_RE.test(slugValue) && slugValue.length >= 3 && slugValue.length <= 80

  // The rename navigates to the new URL; keep the field in sync with it.
  useEffect(() => setSlug(trip.id), [trip.id])

  async function save(patch) {
    setSaving(true)
    setError('')
    try {
      await onSave(patch)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="share-panel card">
      <div className="share-panel-header">
        <h2 className="share-panel-title">Trip Settings</h2>
        {onClose && (
          <button
            type="button"
            className="btn-icon share-panel-close"
            onClick={onClose}
            title="Close settings"
            aria-label="Close settings"
          >
            ✕
          </button>
        )}
      </div>
      <form
        className="share-rename"
        onSubmit={(e) => {
          e.preventDefault()
          if (nameChanged) save({ name: name.trim() })
        }}
      >
        <label className="share-label" htmlFor="trip-name-input">
          Trip name
        </label>
        <div className="share-rename-row">
          <input
            id="trip-name-input"
            type="text"
            value={name}
            maxLength={120}
            disabled={saving}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-small" disabled={saving || !nameChanged}>
            {saving ? 'Saving…' : 'Rename'}
          </button>
        </div>
      </form>

      <form
        className="share-rename"
        onSubmit={(e) => {
          e.preventDefault()
          if (slugChanged && slugValid) save({ slug: slugValue })
        }}
      >
        <label className="share-label" htmlFor="trip-slug-input">
          Trip URL
        </label>
        <div className="share-rename-row">
          <span className="share-slug-prefix">/trips/</span>
          <input
            id="trip-slug-input"
            type="text"
            value={slug}
            maxLength={80}
            disabled={saving}
            spellCheck={false}
            onChange={(e) => setSlug(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary btn-small"
            disabled={saving || !slugChanged || !slugValid}
          >
            {saving ? 'Saving…' : 'Change URL'}
          </button>
        </div>
        <p className="muted share-slug-note">
          Lowercase letters, digits, and hyphens{slugChanged && !slugValid ? ' — this URL isn’t valid yet' : ''}.
          Old links stop working after a change.
        </p>
      </form>

      <div className="share-visibility">
        <span className={`visibility-badge${isPublic ? ' public' : ''}`}>
          {isPublic ? 'Public' : 'Private'}
        </span>
        <p className="muted share-visibility-note">
          {isPublic
            ? 'Anyone can view this trip.'
            : 'Only you and people you share with can view this trip.'}
        </p>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          disabled={saving}
          onClick={() => save({ visibility: isPublic ? 'private' : 'public' })}
        >
          Make {isPublic ? 'Private' : 'Public'}
        </button>
      </div>

      <div className="share-with">
        <span className="share-label">Shared with</span>
        {sharedWith.length === 0 && <span className="muted">no one yet</span>}
        {sharedWith.map((username) => (
          <span key={username} className="share-chip">
            {username}
            <button
              type="button"
              className="share-chip-remove"
              disabled={saving}
              onClick={() => save({ sharedWith: sharedWith.filter((u) => u !== username) })}
              aria-label={`Stop sharing with ${username}`}
              title={`Stop sharing with ${username}`}
            >
              ✕
            </button>
          </span>
        ))}
        <UserCombobox
          exclude={[trip.ownerId, ...sharedWith]}
          disabled={saving}
          onSelect={(username) => save({ sharedWith: [...sharedWith, username] })}
        />
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function UserCombobox({ exclude, onSelect, disabled }) {
  const [users, setUsers] = useState([])
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef(null)

  useEffect(() => {
    api
      .listUsers()
      .then(setUsers)
      .catch(() => setUsers([]))
  }, [])

  useEffect(() => {
    function onClickOutside(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const matches = useMemo(() => filterUsernames(users, query, exclude), [users, query, exclude])
  const clamped = Math.min(highlight, Math.max(matches.length - 1, 0))

  function select(username) {
    onSelect(username)
    setQuery('')
    setOpen(false)
    setHighlight(0)
  }

  function handleKeyDown(e) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(Math.min(clamped + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(Math.max(clamped - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (matches[clamped]) select(matches[clamped])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="user-combobox" ref={rootRef}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-label="Share with user"
        placeholder="Add a person…"
        value={query}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          setHighlight(0)
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />
      {open && (
        <ul className="user-combobox-list" role="listbox">
          {matches.length === 0 ? (
            <li className="user-combobox-empty muted">No matching users</li>
          ) : (
            matches.map((username, i) => (
              <li key={username}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === clamped}
                  className={`user-combobox-option${i === clamped ? ' highlighted' : ''}`}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => select(username)}
                >
                  {username}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
