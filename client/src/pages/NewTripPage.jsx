import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'
import ModelPicker, { preferredModel } from '../components/ModelPicker.jsx'

const HINT = `Describe your trip: destination(s), date range, where you'll start and end each leg, who is traveling, pace and interests.

Example: "Create an itinerary for a trip to Yellowstone from 7/1/2026 through 7/4/2026. We enter from West Yellowstone on the morning of 7/1 and leave toward Rexburg, Idaho on the evening of 7/4. My wife and I are in our mid-50s — long walks are fine, avoid strenuous hikes."`

export default function NewTripPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [aiEnabled, setAiEnabled] = useState(null)
  const [models, setModels] = useState([])
  const [model, setModel] = useState('')
  const [description, setDescription] = useState('')
  const [manual, setManual] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    api
      .aiStatus()
      .then((s) => {
        setAiEnabled(s.enabled)
        setModels(s.models ?? [])
        setModel(preferredModel(s.models ?? []))
      })
      .catch(() => setAiEnabled(false))
  }, [])

  if (user === null) {
    return (
      <p className="empty-note">
        <Link to="/signin">Sign in</Link> to create a trip.
      </p>
    )
  }
  if (user === undefined || aiEnabled === null) return <p className="empty-note">Loading…</p>

  const showAiForm = aiEnabled && !manual

  async function handleAiCreate(e) {
    e.preventDefault()
    if (!description.trim() || creating) return
    setCreating(true)
    setError('')
    try {
      const trip = await api.createAiTrip(description.trim())
      navigate(`/trips/${trip.id}`, { state: { initialPrompt: description.trim(), model } })
    } catch (err) {
      setError(err.message)
      setCreating(false)
    }
  }

  async function handleManualCreate(e) {
    e.preventDefault()
    if (!name.trim() || creating) return
    setCreating(true)
    setError('')
    try {
      const trip = await api.createTrip(name.trim())
      navigate(`/trips/${trip.id}`)
    } catch (err) {
      setError(err.message)
      setCreating(false)
    }
  }

  return (
    <div className="new-trip card">
      {showAiForm ? (
        <form onSubmit={handleAiCreate}>
          <h1>Describe your trip</h1>
          <p className="muted">
            The assistant will name the trip, set the dates, and draft a day-by-day itinerary you
            can refine in chat.
          </p>
          <textarea
            className="new-trip-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={HINT}
            rows={10}
            autoFocus
          />
          <ModelPicker models={models} value={model} onChange={setModel} disabled={creating} />
          {error && <p className="error">{error}</p>}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={!description.trim() || creating}>
              {creating ? 'Creating…' : 'Create Itinerary'}
            </button>
            <button type="button" className="btn btn-link" onClick={() => setManual(true)}>
              set up manually instead
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={handleManualCreate}>
          <h1>Create a trip</h1>
          <p className="muted">Name your trip, then pick dates and add each day’s plan yourself.</p>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Trip name, e.g. Europe 2026"
            aria-label="New trip name"
            maxLength={120}
            autoFocus
          />
          {error && <p className="error">{error}</p>}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={!name.trim() || creating}>
              {creating ? 'Creating…' : 'Create Trip'}
            </button>
            {aiEnabled && (
              <button type="button" className="btn btn-link" onClick={() => setManual(false)}>
                describe it to the assistant instead
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  )
}
