// Slug basis for agent-named trips. The trip id/URL should read like
// "yellowstone-july-2026-<suffix>": the destination (or the traveler's chosen
// name) plus the trip's month and year — without repeating a month or year
// the name already mentions.

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

// Returns the human-readable basis string to slugify (the caller's slugify
// appends the random suffix). Uses the trip's earliest day for month/year;
// a trip with no days yet gets just the name.
export function agentSlugBasis(trip) {
  const name = trip.name ?? ''
  const firstDate = Object.keys(trip.days ?? {}).sort()[0]
  if (!firstDate) return name
  const lower = name.toLowerCase()
  const month = MONTH_NAMES[Number(firstDate.slice(5, 7)) - 1]
  const year = firstDate.slice(0, 4)
  if (lower.includes(year)) return name
  if (lower.includes(month)) return `${name} ${year}`
  return `${name} ${month} ${year}`
}
