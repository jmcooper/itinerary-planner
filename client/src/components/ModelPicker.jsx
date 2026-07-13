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

// Groups consecutive models sharing a provider (the server sends them grouped,
// newest first within each group).
function groupByProvider(models) {
  const groups = []
  for (const model of models) {
    const provider = model.provider ?? 'Models'
    const last = groups[groups.length - 1]
    if (last && last.provider === provider) last.models.push(model)
    else groups.push({ provider, models: [model] })
  }
  return groups
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
        {groupByProvider(models).map((group) => (
          <optgroup key={group.provider} label={group.provider}>
            {group.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}
