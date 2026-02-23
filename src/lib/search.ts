import type { MemoryEntry } from "./storage.js"

/**
 * Search memory entries by matching query keywords against summaries,
 * topics, decisions, and project paths.
 *
 * Uses simple keyword matching — no embedding DB required.
 * Keywords are split on whitespace and commas.
 * An entry matches if ANY keyword appears in ANY of its searchable fields.
 * Results are scored by number of keyword hits and sorted descending.
 */
export function searchEntries(
  entries: MemoryEntry[],
  query: string
): MemoryEntry[] {
  const keywords = query
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((k) => k.length > 1) // skip single chars

  if (keywords.length === 0) return entries

  const scored = entries
    .map((entry) => {
      const searchable = [
        entry.summary,
        entry.keyTopics,
        entry.decisions,
        entry.project,
        entry.date,
        entry.unfinished ?? "",
      ]
        .join(" ")
        .toLowerCase()

      let score = 0
      for (const keyword of keywords) {
        // Count occurrences across all fields
        const regex = new RegExp(escapeRegex(keyword), "gi")
        const matches = searchable.match(regex)
        if (matches) {
          score += matches.length
        }
      }

      return { entry, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.map((item) => item.entry)
}

/**
 * Filter entries by date range.
 * Accepts relative terms like "today", "yesterday", "last week", "this month"
 * or ISO date strings.
 */
export function filterByDate(
  entries: MemoryEntry[],
  dateQuery: string
): MemoryEntry[] {
  const now = new Date()
  const today = formatDate(now)

  const lower = dateQuery.toLowerCase().trim()

  if (lower === "today") {
    return entries.filter((e) => e.date === today)
  }

  if (lower === "yesterday") {
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    return entries.filter((e) => e.date === formatDate(yesterday))
  }

  if (lower === "last week" || lower === "this week") {
    const weekAgo = new Date(now)
    weekAgo.setDate(weekAgo.getDate() - 7)
    const cutoff = formatDate(weekAgo)
    return entries.filter((e) => e.date >= cutoff)
  }

  if (lower === "last month" || lower === "this month") {
    const monthAgo = new Date(now)
    monthAgo.setMonth(monthAgo.getMonth() - 1)
    const cutoff = formatDate(monthAgo)
    return entries.filter((e) => e.date >= cutoff)
  }

  // Try as ISO date prefix (e.g., "2026-02" matches all Feb 2026)
  if (/^\d{4}/.test(lower)) {
    return entries.filter((e) => e.date.startsWith(lower))
  }

  return entries
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
