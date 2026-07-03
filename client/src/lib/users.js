// Filter usernames for the share combobox: empty query returns everyone
// (minus exclusions); otherwise prefix matches rank before substring matches.
export function filterUsernames(all, query, exclude = []) {
  const q = query.trim().toLowerCase()
  const excluded = new Set(exclude)
  const candidates = all.filter((u) => !excluded.has(u))
  if (!q) return candidates
  const prefix = []
  const substring = []
  for (const u of candidates) {
    if (u.startsWith(q)) prefix.push(u)
    else if (u.includes(q)) substring.push(u)
  }
  return [...prefix, ...substring]
}
