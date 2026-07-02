// Parsing for the day-import flow: a CSV of itinerary lines (Time,Plan,Detail-code)
// plus a markdown document of `## S1 — Title` sections separated by `---` lines.

const HEADING_RE = /^(#{1,6})\s*([A-Za-z][A-Za-z0-9]*)\s*[—–-]\s+(.*)$/

function parseCsvLine(line) {
  const fields = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      fields.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  fields.push(field)
  return fields.map((f) => f.trim())
}

export function parseCsv(text) {
  const lines = (text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '')
  const rows = []
  let skipped = 0
  for (const [index, line] of lines.entries()) {
    const fields = parseCsvLine(line)
    if (index === 0 && /^time$/i.test(fields[0] ?? '')) continue
    if (fields.length < 2 || fields[0] === '' || fields[1] === '') {
      skipped++
      continue
    }
    rows.push({ time: fields[0], plan: fields[1], code: fields[2] ?? '' })
  }
  return { rows, skipped }
}

export function parseDetails(text) {
  const chunks = (text ?? '').split(/^\s*---\s*$/m)
  const sections = []
  for (const chunk of chunks) {
    const markdown = chunk.trim()
    if (!markdown) continue
    let code = ''
    let title = ''
    for (const line of markdown.split('\n')) {
      const heading = line.match(/^#{1,6}\s+(.*)$/)
      if (!heading) continue
      const coded = line.match(HEADING_RE)
      if (coded) {
        code = coded[2]
        title = coded[3].trim()
      } else {
        title = heading[1].trim()
      }
      break
    }
    sections.push({ code, title, markdown })
  }
  return sections
}

export function buildDayItems(csvText, detailsText) {
  const { rows, skipped } = parseCsv(csvText)
  const sections = parseDetails(detailsText)
  const byCode = new Map()
  for (const section of sections) {
    if (section.code && !byCode.has(section.code)) byCode.set(section.code, section)
  }

  const warnings = []
  if (skipped > 0) warnings.push(`${skipped} CSV row(s) could not be parsed and were skipped.`)

  const usedCodes = new Set()
  const items = rows.map((row) => {
    const section = row.code ? byCode.get(row.code) : undefined
    if (section) usedCodes.add(row.code)
    return { time: row.time, plan: row.plan, code: row.code, details: section?.markdown ?? '' }
  })

  const unmatchedRows = items.filter((it) => it.code && !it.details)
  if (unmatchedRows.length > 0)
    warnings.push(
      `No details section found for: ${unmatchedRows.map((it) => it.code).join(', ')}.`
    )

  const orphanSections = sections.filter((s) => s.code && !usedCodes.has(s.code))
  if (orphanSections.length > 0) {
    warnings.push(
      `Details section(s) without a matching CSV row were appended: ${orphanSections
        .map((s) => s.code)
        .join(', ')}.`
    )
    for (const section of orphanSections) {
      items.push({ time: '', plan: section.title || section.code, code: section.code, details: section.markdown })
    }
  }

  return { items, warnings }
}

// For display: `## S1 — Leave hotel` → `## Leave hotel`
export function stripCodeFromHeadings(markdown) {
  return (markdown ?? '')
    .split('\n')
    .map((line) => {
      const m = line.match(HEADING_RE)
      return m ? `${m[1]} ${m[3]}` : line
    })
    .join('\n')
}
