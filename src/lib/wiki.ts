import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { redactSecrets } from "./redact.js"

/** Allowed page types (OKF-compatible subset) */
export type PageType = "Project" | "Topic" | "Investigation"

export interface WikiPage {
  /** Path relative to the wiki root, e.g. "topics/s3-troubleshooting.md" */
  relPath: string
  type: PageType
  title: string
  /** One-line summary — feeds the derived TOC */
  description: string
  tags: string[]
  timestamp: string
  /** Project pages only: absolute path of the code directory this page documents */
  codePath?: string
  /** Session IDs this page's knowledge came from (provenance, not retellings) */
  sourceSessions?: string[]
  /** Markdown body (everything after the frontmatter) */
  body: string
}

/** Hard cap on body length — forces distillation over accumulation */
export const MAX_BODY_LINES = 150

/** Character budget for the injected TOC (~3.5K tokens). A page missing from
 * the TOC is invisible at recall time, so the budget must fit the corpus:
 * box-2 acceptance test produced 89 pages / ~12.6K chars of descriptions and
 * the original 3,200 budget silently hid ~75% of the wiki. */
export const TOC_CHAR_BUDGET = 14_000

/**
 * Wiki root directory. Overridable via OPENCODE_WIKI_DIR, defaults to ~/wiki.
 */
export function getWikiDir(): string {
  return process.env["OPENCODE_WIKI_DIR"] ?? join(homedir(), "wiki")
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/** Convert arbitrary text into a filesystem-safe slug */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled"
}

/**
 * Parse the YAML frontmatter block of a page. Supports the flat subset OKF
 * uses (string values, [a, b] inline lists) — not a general YAML parser.
 */
export function parseFrontmatter(content: string): { fields: Record<string, string>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return null

  const fields: Record<string, string> = {}
  for (const line of match[1]!.split("\n")) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/)
    if (!kv) continue
    let value = kv[2]!.trim()
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    fields[kv[1]!] = value
  }
  return { fields, body: match[2] ?? "" }
}

/** Parse an inline [a, b, c] tag list */
function parseTags(value: string | undefined): string[] {
  if (!value) return []
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
}

/** Read and parse a single page. Returns null on any failure. */
export function readPage(relPath: string): WikiPage | null {
  try {
    const filePath = join(getWikiDir(), relPath)
    if (!existsSync(filePath)) return null
    const parsed = parseFrontmatter(readFileSync(filePath, "utf-8"))
    if (!parsed) return null

    const { fields, body } = parsed
    const type = fields["type"] as PageType | undefined
    if (type !== "Project" && type !== "Topic" && type !== "Investigation") return null

    return {
      relPath,
      type,
      title: fields["title"] ?? "",
      description: fields["description"] ?? "",
      tags: parseTags(fields["tags"]),
      timestamp: fields["timestamp"] ?? "",
      codePath: fields["code_path"],
      sourceSessions: parseTags(fields["source_sessions"]),
      body: body.trim(),
    }
  } catch {
    return null
  }
}

/**
 * Validate a page before writing. Returns an error string, or null if valid.
 * Machine-enforced conformance — rejects instead of trusting prose rules.
 */
export function validatePage(page: WikiPage): string | null {
  if (!page.title.trim()) return "title must not be empty"
  if (!page.description.trim()) return "description must not be empty — it becomes this page's line in the always-injected TOC"
  if (page.description.length > 200) return "description too long (max 200 chars) — it must fit on one TOC line"
  if (page.type === "Project" && !page.codePath) return "Project pages require code_path (the absolute path of the code directory they document)"
  const lines = page.body.split("\n").length
  if (lines > MAX_BODY_LINES) {
    return `body is ${lines} lines — cap is ${MAX_BODY_LINES}. Distill harder: keep reusable patterns, drop session narrative.`
  }
  return null
}

/** Serialize a page to markdown with frontmatter */
export function serializePage(page: WikiPage): string {
  let out = "---\n"
  out += `type: ${page.type}\n`
  out += `title: "${page.title.replace(/"/g, "'")}"\n`
  out += `description: "${page.description.replace(/"/g, "'")}"\n`
  out += `tags: [${page.tags.join(", ")}]\n`
  out += `timestamp: ${page.timestamp || new Date().toISOString()}\n`
  if (page.codePath) out += `code_path: ${page.codePath}\n`
  if (page.sourceSessions && page.sourceSessions.length > 0) {
    out += `source_sessions: [${page.sourceSessions.join(", ")}]\n`
  }
  out += "---\n\n"
  out += page.body.trim() + "\n"
  return out
}

/**
 * Write a page (full replacement — read-merge-rewrite is the caller's job).
 * Credentials are stripped here: this is the single write choke point, so
 * nothing reaches disk unscanned. Returns the labels of anything redacted
 * (empty when clean) so the caller can surface it — redaction is never silent.
 * Throws on validation failure.
 */
export function writePage(page: WikiPage): string[] {
  const bodyScan = redactSecrets(page.body)
  const descScan = redactSecrets(page.description)
  const clean: WikiPage = { ...page, body: bodyScan.text, description: descScan.text }
  const redacted = [...new Set([...bodyScan.found, ...descScan.found])]

  const error = validatePage(clean)
  if (error) throw new Error(`Invalid page ${page.relPath}: ${error}`)

  const filePath = join(getWikiDir(), clean.relPath)
  ensureDir(dirname(filePath))
  writeFileSync(filePath, serializePage(clean), "utf-8")
  invalidatePageCache()
  return redacted
}

/** Compute the canonical relative path for a page by type */
export function pathFor(type: PageType, slug: string, date?: string): string {
  if (type === "Project") return join("projects", slug, "overview.md")
  if (type === "Topic") return join("topics", `${slug}.md`)
  const prefix = date ?? new Date().toISOString().slice(0, 10)
  return join("investigations", `${prefix}-${slug}.md`)
}

/** Cached page list — invalidated on every write so same-run visibility of
 * freshly written pages is preserved (distillation depends on it). */
let pageCache: { pages: WikiPage[]; at: number } | null = null
const PAGE_CACHE_TTL_MS = 5_000

export function invalidatePageCache(): void {
  pageCache = null
}

/**
 * List all pages in the wiki (projects, topics, investigations).
 * Reads every page's frontmatter; bodies are included (files are capped small).
 * Result is briefly cached; any write invalidates the cache immediately.
 */
export function listPages(): WikiPage[] {
  if (pageCache && Date.now() - pageCache.at < PAGE_CACHE_TTL_MS) {
    return pageCache.pages
  }

  const wikiDir = getWikiDir()
  const pages: WikiPage[] = []

  // projects/<name>/overview.md
  try {
    for (const entry of readdirSync(join(wikiDir, "projects"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const rel = join("projects", entry.name, "overview.md")
      const page = readPage(rel)
      if (page) pages.push(page)
    }
  } catch {}

  // topics/*.md and investigations/*.md
  for (const section of ["topics", "investigations"]) {
    try {
      for (const file of readdirSync(join(wikiDir, section))) {
        if (!file.endsWith(".md")) continue
        const page = readPage(join(section, file))
        if (page) pages.push(page)
      }
    } catch {}
  }

  pageCache = { pages, at: Date.now() }
  return pages
}

/**
 * Find the Project page whose code_path contains the given directory.
 * Longest matching code_path wins (handles nested checkouts).
 */
export function findProjectPage(directory: string, pages?: WikiPage[]): WikiPage | null {
  const candidates = (pages ?? listPages())
    .filter((p) => p.type === "Project" && p.codePath)
    .filter((p) => directory === p.codePath || directory.startsWith(p.codePath! + "/"))
    .sort((a, b) => b.codePath!.length - a.codePath!.length)
  return candidates[0] ?? null
}

/**
 * Derive the TOC from page frontmatter. Never maintained as a file — always
 * generated from what is actually on disk, so it cannot drift.
 * Compact format: section headers carry the path template once, entries are
 * bare slugs.
 *
 * ALL page types are listed, investigations included: an investigation
 * frequently carries reusable technique, and listing only a count made that
 * knowledge undiscoverable unless a keyword search happened to hit it.
 * Discoverability beats token thrift.
 */
export function deriveTOC(pages?: WikiPage[]): string {
  const all = pages ?? listPages()
  if (all.length === 0) return ""

  const bySlug = (a: WikiPage, b: WikiPage) => a.relPath.localeCompare(b.relPath)
  const topics = all.filter((p) => p.type === "Topic").sort(bySlug)
  const projects = all.filter((p) => p.type === "Project").sort(bySlug)
  // Newest investigations first — recent troubleshooting is likelier relevant
  const investigations = all.filter((p) => p.type === "Investigation").sort((a, b) => b.relPath.localeCompare(a.relPath))

  const sections: Array<{ header: string; pages: WikiPage[] }> = [
    { header: `TOPICS — load with memory_recall page="topics/<slug>.md":`, pages: topics },
    { header: `PROJECTS — load with memory_recall page="projects/<slug>/overview.md":`, pages: projects },
    { header: `INVESTIGATIONS — load with memory_recall page="investigations/<name>.md":`, pages: investigations },
  ]

  // Budget is enforced per section so no single type can crowd out the others
  let out = ""
  let truncated = 0
  for (const section of sections) {
    if (section.pages.length === 0) continue
    const share = Math.floor(TOC_CHAR_BUDGET / sections.filter((s) => s.pages.length > 0).length)
    let used = 0
    let sectionOut = section.header + "\n"
    for (const p of section.pages) {
      const line = `- ${tocSlug(p)}: ${p.description}\n`
      if (used + line.length > share) {
        truncated++
        continue
      }
      sectionOut += line
      used += line.length
    }
    out += sectionOut
  }
  if (truncated > 0) {
    out +=
      `(+${truncated} more pages not shown — TOC budget reached. ` +
      `memory_recall with no args lists everything; memory_status reports index health)\n`
  }
  return out.trimEnd()
}

/** Number of pages omitted from the derived TOC (0 when everything fits) */
export function tocTruncationCount(pages?: WikiPage[]): number {
  const all = pages ?? listPages()
  const shown = deriveTOC(all).split("\n").filter((l) => l.startsWith("- ")).length
  return Math.max(0, all.length - shown)
}

/** Extract the bare slug used in TOC lines from a page's relPath */
function tocSlug(page: WikiPage): string {
  if (page.type === "Project") {
    const parts = page.relPath.split("/")
    return parts[1] ?? page.relPath
  }
  const file = page.relPath.split("/").pop() ?? page.relPath
  return file.replace(/\.md$/, "")
}
