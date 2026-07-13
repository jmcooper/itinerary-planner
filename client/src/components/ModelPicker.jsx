const STORAGE_KEY = 'itinerary-ai-model'

// Returns the remembered model when it's still offered, else the first model.
export function preferredModel(models) {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved && models.some((m) => m.id === saved)) return saved
  return models[0]?.id ?? ''
}

export function rememberModel(id) {
  localStorage.setItem(STORAGE_KEY, id)
}

export default function ModelPicker({ models, value, onChange, disabled }) {
  if (models.length <= 1) return null
  return (
    <label className="model-picker">
      Model
      <select
        value={value}
        onChange={(e) => {
          rememberModel(e.target.value)
          onChange(e.target.value)
        }}
        disabled={disabled}
        aria-label="AI model"
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  )
}
