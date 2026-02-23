import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

export interface MemoryEntry {
  date: string
  sessionID: string
  project: string
  summary: string
  keyTopics: string
  decisions: string
  unfinished?: string
  sessionFilePath: string
}

export interface SessionDetail {
  sessionID: string
  date: string
  project: string
  model?: string
  tokensUsed?: number
  contextPercent?: number
  summary: string
  keyTopics: string
  decisions: string
  codeChanges?: string
  importantContext?: string
  unfinished?: string
}

const MEMORY_DIR = join(homedir(), ".config", "opencode", "memory")
const INDEX_FILE = join(MEMORY_DIR, "MEMORY.md")

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function getLocalSessionDir(projectDir: string): string {
  return join(projectDir, ".opencode", "memory", "sessions")
}

function getSessionFileName(date: string, sessionID: string): string {
  const shortID = sessionID.length > 8 ? sessionID.slice(0, 8) : sessionID
  return `${date}_${shortID}.md`
}

export function readIndex(): string {
  ensureDir(MEMORY_DIR)
  if (!existsSync(INDEX_FILE)) {
    return ""
  }
  return readFileSync(INDEX_FILE, "utf-8")
}

export function parseIndexEntries(indexContent: string): MemoryEntry[] {
  if (!indexContent.trim()) return []

  const entries: MemoryEntry[] = []
  const blocks = indexContent.split(/\n---\n/)

  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed || trimmed === "# Memory Index") continue

    const headerMatch = trimmed.match(
      /^## (\d{4}-\d{2}-\d{2}) \| Session (\S+) \| Project: (.+)$/m
    )
    if (!headerMatch) continue

    const [, date, sessionID, project] = headerMatch
    const summaryMatch = trimmed.match(/\*\*Summary\*\*: (.+)$/m)
    const topicsMatch = trimmed.match(/\*\*Key Topics\*\*: (.+)$/m)
    const decisionsMatch = trimmed.match(/\*\*Decisions\*\*: (.+)$/m)
    const unfinishedMatch = trimmed.match(/\*\*Unfinished\*\*: (.+)$/m)
    const fileMatch = trimmed.match(/\*\*Session File\*\*: (.+)$/m)

    entries.push({
      date: date!,
      sessionID: sessionID!,
      project: project!,
      summary: summaryMatch?.[1] ?? "",
      keyTopics: topicsMatch?.[1] ?? "",
      decisions: decisionsMatch?.[1] ?? "",
      unfinished: unfinishedMatch?.[1],
      sessionFilePath: fileMatch?.[1] ?? "",
    })
  }

  return entries
}

export function writeIndexEntry(entry: MemoryEntry): void {
  ensureDir(MEMORY_DIR)

  const existingContent = readIndex()
  const existingEntries = parseIndexEntries(existingContent)

  // Check if entry for this session already exists — update it
  const existingIdx = existingEntries.findIndex(
    (e) => e.sessionID === entry.sessionID
  )

  const entryBlock = formatIndexEntry(entry)

  if (existingIdx >= 0) {
    // Replace existing entry
    existingEntries[existingIdx] = entry
    const newContent = formatFullIndex(existingEntries)
    writeFileSync(INDEX_FILE, newContent, "utf-8")
  } else {
    // Prepend new entry (newest first)
    existingEntries.unshift(entry)
    const newContent = formatFullIndex(existingEntries)
    writeFileSync(INDEX_FILE, newContent, "utf-8")
  }
}

function formatIndexEntry(entry: MemoryEntry): string {
  let block = `## ${entry.date} | Session ${entry.sessionID} | Project: ${entry.project}\n`
  block += `**Summary**: ${entry.summary}\n`
  block += `**Key Topics**: ${entry.keyTopics}\n`
  block += `**Decisions**: ${entry.decisions}\n`
  if (entry.unfinished) {
    block += `**Unfinished**: ${entry.unfinished}\n`
  }
  block += `**Session File**: ${entry.sessionFilePath}`
  return block
}

function formatFullIndex(entries: MemoryEntry[]): string {
  let content = "# Memory Index\n\n"
  content += entries.map(formatIndexEntry).join("\n\n---\n\n")
  content += "\n"
  return content
}

export function writeSessionFile(
  projectDir: string,
  detail: SessionDetail
): string {
  const sessionsDir = getLocalSessionDir(projectDir)
  ensureDir(sessionsDir)

  const fileName = getSessionFileName(detail.date, detail.sessionID)
  const filePath = join(sessionsDir, fileName)

  let content = `# Session ${detail.sessionID} — ${detail.date}\n\n`
  content += `**Project**: ${detail.project}\n`
  if (detail.model) content += `**Model**: ${detail.model}\n`
  if (detail.tokensUsed != null) {
    content += `**Context Used**: ${detail.tokensUsed.toLocaleString()} tokens`
    if (detail.contextPercent != null) {
      content += ` (${detail.contextPercent}%)`
    }
    content += "\n"
  }

  content += `\n## Summary\n${detail.summary}\n`
  content += `\n## Key Topics\n${detail.keyTopics}\n`
  content += `\n## Decisions\n${detail.decisions}\n`

  if (detail.codeChanges) {
    content += `\n## Code Changes\n${detail.codeChanges}\n`
  }
  if (detail.importantContext) {
    content += `\n## Important Context for Future Sessions\n${detail.importantContext}\n`
  }
  if (detail.unfinished) {
    content += `\n## Unfinished / Next Steps\n${detail.unfinished}\n`
  }

  writeFileSync(filePath, content, "utf-8")
  return filePath
}

export function readSessionFile(filePath: string): string {
  if (!existsSync(filePath)) {
    return `Session file not found: ${filePath}`
  }
  return readFileSync(filePath, "utf-8")
}
