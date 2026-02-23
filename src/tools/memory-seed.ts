import { tool } from "@opencode-ai/plugin/tool"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, basename } from "node:path"
import {
  readIndex,
  parseIndexEntries,
  writeIndexEntry,
  type MemoryEntry,
} from "../lib/storage.js"

/**
 * Recursively find all .opencode/memory/sessions/ directories under a root path.
 * Returns the project directory (parent of .opencode/) for each found.
 */
function findMemoryDirs(rootPath: string, maxDepth: number = 5): string[] {
  const results: string[] = []

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return

    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === "node_modules" || entry.name === ".git") continue

        const fullPath = join(dir, entry.name)

        if (entry.name === ".opencode") {
          const sessionsDir = join(fullPath, "memory", "sessions")
          if (existsSync(sessionsDir)) {
            results.push(dir) // the project dir is the parent of .opencode
          }
        } else {
          walk(fullPath, depth + 1)
        }
      }
    } catch {
      // Permission denied or similar — skip
    }
  }

  walk(rootPath, 0)
  return results
}

/**
 * Parse a session markdown file to extract metadata for the global index.
 */
function parseSessionFile(
  filePath: string,
  projectDir: string
): MemoryEntry | null {
  try {
    const content = readFileSync(filePath, "utf-8")
    const fileName = basename(filePath, ".md")

    // Extract date and session ID from filename: YYYY-MM-DD_sessionID
    const fileMatch = fileName.match(/^(\d{4}-\d{2}-\d{2})_(.+)$/)
    if (!fileMatch) return null

    const [, date, sessionID] = fileMatch

    // Extract fields from the markdown content
    const summaryMatch = content.match(/## Summary\n([\s\S]*?)(?=\n## |\n*$)/)
    const topicsMatch = content.match(/## Key Topics\n([\s\S]*?)(?=\n## |\n*$)/)
    const decisionsMatch = content.match(/## Decisions\n([\s\S]*?)(?=\n## |\n*$)/)
    const unfinishedMatch = content.match(
      /## Unfinished[^\n]*\n([\s\S]*?)(?=\n## |\n*$)/
    )

    // Collapse multi-line content to single line for the index
    const collapse = (text: string | undefined): string => {
      if (!text) return ""
      return text.trim().replace(/\n/g, " ").slice(0, 500)
    }

    return {
      date: date!,
      sessionID: sessionID!,
      project: projectDir,
      summary: collapse(summaryMatch?.[1]) || "Auto-seeded from existing session file",
      keyTopics: collapse(topicsMatch?.[1]) || "",
      decisions: collapse(decisionsMatch?.[1]) || "",
      unfinished: collapse(unfinishedMatch?.[1]) || undefined,
      sessionFilePath: filePath,
    }
  } catch {
    return null
  }
}

export function createMemorySeedTool() {
  return tool({
    description:
      "One-time seed of the global memory index by scanning a directory tree for existing " +
      "local session files (.opencode/memory/sessions/). Finds all projects with session " +
      "data and adds them to the global MEMORY.md index. Safe to run multiple times — " +
      "existing entries are updated, not duplicated.",
    args: {
      path: tool.schema
        .string()
        .describe(
          "Root directory to scan for projects with .opencode/memory/sessions/ directories. " +
          "Example: '/code' or '/home/user'."
        ),
      max_depth: tool.schema
        .number()
        .optional()
        .describe("Maximum directory depth to scan. Default: 5."),
    },
    async execute(args) {
      const scanPath = args.path
      if (!existsSync(scanPath)) {
        return `Path does not exist: ${scanPath}`
      }

      const projectDirs = findMemoryDirs(scanPath, args.max_depth ?? 5)

      if (projectDirs.length === 0) {
        return `No .opencode/memory/sessions/ directories found under: ${scanPath}`
      }

      // Get existing index entries so we can skip duplicates
      const existingContent = readIndex()
      const existingEntries = parseIndexEntries(existingContent)
      const existingSessionIDs = new Set(existingEntries.map((e) => e.sessionID))

      let added = 0
      let updated = 0
      let skipped = 0
      const details: string[] = []

      for (const projectDir of projectDirs) {
        const sessionsDir = join(projectDir, ".opencode", "memory", "sessions")
        let sessionFiles: string[]

        try {
          sessionFiles = readdirSync(sessionsDir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => join(sessionsDir, f))
        } catch {
          continue
        }

        for (const sessionFile of sessionFiles) {
          const entry = parseSessionFile(sessionFile, projectDir)
          if (!entry) {
            skipped++
            continue
          }

          if (existingSessionIDs.has(entry.sessionID)) {
            // Update existing entry
            writeIndexEntry(entry)
            updated++
          } else {
            writeIndexEntry(entry)
            existingSessionIDs.add(entry.sessionID)
            added++
          }
        }

        details.push(`${projectDir}: ${sessionFiles.length} session file(s)`)
      }

      const lines = [
        `Seed complete.`,
        ``,
        `Projects scanned: ${projectDirs.length}`,
        `Sessions added: ${added}`,
        `Sessions updated: ${updated}`,
        `Sessions skipped (unparseable): ${skipped}`,
        ``,
        `Projects found:`,
        ...details.map((d) => `  ${d}`),
      ]

      return lines.join("\n")
    },
  })
}
