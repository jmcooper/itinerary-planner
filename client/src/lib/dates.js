// Date-string helpers. Dates are plain YYYY-MM-DD strings everywhere; convert
// through Date.UTC so local timezone never shifts a day.

export function listDates(startDate, endDate) {
  if (!startDate || !endDate) return []
  const start = toUtc(startDate)
  const end = toUtc(endDate)
  const dates = []
  for (let t = start; t <= end && dates.length < 366; t += 86400000) {
    dates.push(new Date(t).toISOString().slice(0, 10))
  }
  return dates
}

function toUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatDay(dateStr) {
  const date = new Date(toUtc(dateStr))
  return {
    weekday: WEEKDAYS[date.getUTCDay()],
    label: `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`,
    year: date.getUTCFullYear(),
  }
}

export function formatRange(startDate, endDate) {
  if (!startDate || !endDate) return 'No dates yet'
  const a = formatDay(startDate)
  const b = formatDay(endDate)
  return `${a.label} – ${b.label}, ${b.year}`
}
