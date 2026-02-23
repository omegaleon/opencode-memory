import { tool } from "@opencode-ai/plugin/tool"
import { existsSync } from "node:fs"
import {
  readIndex,
  parseIndexEntries,
  readSessionFile,
} from "../lib/storage.js"
import { searchEntries, filterByDate } from "../lib/search.js"

export function createMemoryRecallTool() {
  return tool({
    description:
      "Recall past session context from persistent memory. " +
      "First searches the global memory index for matching summaries (fast). " +
      "Pass a session_id to load full session detail from the local project file. " +
      "Supports date filters like 'today', 'yesterday', 'last week', 'this month', or '2026-02'.",
    args: {
      query: tool.schema
        .string()
        .describe(
          "Search query — keywords to match against summaries, topics, decisions, project paths. " +
          "Also accepts date terms: 'today', 'yesterday', 'last week', 'this month', or ISO date prefix like '2026-02'."
        ),
      session_id: tool.schema
        .string()
        .optional()
        .describe(
          "Optional: specific session ID to load full detail. " +
          "Get this from a previous memory_recall search result."
        ),
    },
    async execute(args) {
      // If a specific session is requested, load its full file
      if (args.session_id) {
        const indexContent = readIndex()
        const entries = parseIndexEntries(indexContent)
        const entry = entries.find((e) =>
          e.sessionID.startsWith(args.session_id!)
        )

        if (!entry) {
          return `No session found matching ID: ${args.session_id}`
        }

        // Check if local session file still exists
        if (!existsSync(entry.sessionFilePath)) {
          // Fallback: return what we have from the global index
          const lines = [
            `WARNING: Session file not found at: ${entry.sessionFilePath}`,
            `The project may have been moved or deleted.`,
            ``,
            `Returning data from global memory index:`,
            ``,
            `Date: ${entry.date}`,
            `Session: ${entry.sessionID}`,
            `Project: ${entry.project}`,
            `Summary: ${entry.summary}`,
            `Key Topics: ${entry.keyTopics}`,
            `Decisions: ${entry.decisions}`,
          ]
          if (entry.unfinished) {
            lines.push(`Unfinished: ${entry.unfinished}`)
          }
          return lines.join("\n")
        }

        const content = readSessionFile(entry.sessionFilePath)
        return content
      }

      // Otherwise, search the index
      const indexContent = readIndex()
      if (!indexContent.trim()) {
        return "Memory is empty. No sessions have been saved yet."
      }

      let entries = parseIndexEntries(indexContent)
      if (entries.length === 0) {
        return "Memory index exists but contains no parseable entries."
      }

      // Apply date filter if the query looks like a date term
      const dateTerms = [
        "today",
        "yesterday",
        "last week",
        "this week",
        "last month",
        "this month",
      ]
      const queryLower = args.query.toLowerCase().trim()
      const isDateQuery =
        dateTerms.some((t) => queryLower.includes(t)) ||
        /^\d{4}/.test(queryLower)

      if (isDateQuery) {
        entries = filterByDate(entries, queryLower)
        if (entries.length === 0) {
          return `No sessions found for date filter: ${args.query}`
        }
      }

      // Apply keyword search
      const results = searchEntries(entries, args.query)

      if (results.length === 0) {
        // Return all entries if no matches but date filter was applied
        if (isDateQuery && entries.length > 0) {
          return formatResults(entries.slice(0, 20))
        }
        return `No sessions found matching: ${args.query}\n\nTotal sessions in memory: ${entries.length}`
      }

      return formatResults(results.slice(0, 20))
    },
  })
}

function formatResults(entries: ReturnType<typeof parseIndexEntries>): string {
  const lines = [`Found ${entries.length} matching session(s):\n`]

  for (const entry of entries) {
    const fileExists = existsSync(entry.sessionFilePath)
    lines.push(`--- ${entry.date} | Session ${entry.sessionID} | ${entry.project}`)
    lines.push(`Summary: ${entry.summary}`)
    lines.push(`Topics: ${entry.keyTopics}`)
    if (entry.decisions) lines.push(`Decisions: ${entry.decisions}`)
    if (entry.unfinished) lines.push(`Unfinished: ${entry.unfinished}`)
    if (fileExists) {
      lines.push(`Full detail: call memory_recall with session_id="${entry.sessionID}"`)
    } else {
      lines.push(`[Session file missing — this is all available data for this session]`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
