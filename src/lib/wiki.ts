import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
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

/**
 * Max description length. Unlike the body cap this is NOT a hard reject:
 * the description is metadata, and discarding a validated 150-line body of
 * real engineering knowledge because its one-line summary ran 30 chars long
 * loses far more than clipping the summary does. Over-long descriptions are
 * truncated at write time and the truncation is reported.
 */
export const MAX_DESCRIPTION_CHARS = 200

/**
 * Hard cap on body size in characters. The line cap alone is not a bound —
 * 150 lines of minified JSON or a pasted log is megabytes, which would blow
 * up any session that recalls the page.
 */
export const MAX_BODY_CHARS = 24_000

/**
 * Share of the model's context window the injected index may occupy.
 * Override with OPENCODE_WIKI_TOC_SHARE (e.g. 0.15 for 15%).
 */
export const TOC_CONTEXT_SHARE = (() => {
  const raw = Number(process.env["OPENCODE_WIKI_TOC_SHARE"])
  return Number.isFinite(raw) && raw > 0 && raw <= 0.5 ? raw : 0.1
})()

/**
 * Chars per token for budget math. Deliberately conservative: index lines are
 * hyphenated technical slugs ("elasticsearch-indexing-pressure") which tokenize
 * far denser than prose's ~4 chars/token, so 3.25 keeps the real token cost at
 * or below the configured share rather than overshooting it.
 */
const CHARS_PER_TOKEN = 3.25

/** Absolute floor so a small-context model still gets a usable index */
const TOC_CHAR_FLOOR = 8_000

/**
 * Optional ceiling on the injected index. Unset by default — the budget is
 * whatever the configured share of the context window works out to. Set
 * OPENCODE_WIKI_TOC_CEILING to cap it.
 */
const TOC_CHAR_CEILING = (() => {
  const raw = Number(process.env["OPENCODE_WIKI_TOC_CEILING"])
  return Number.isFinite(raw) && raw > 1000 ? raw : Number.POSITIVE_INFINITY
})()

/**
 * Optional max description length on a TOC line. Unset by default — the full
 * description is carried. Set OPENCODE_WIKI_TOC_DESC_CHARS to clip it, which
 * trades index detail for how many pages fit.
 */
export const TOC_DESC_CHARS = (() => {
  const raw = Number(process.env["OPENCODE_WIKI_TOC_DESC_CHARS"])
  return Number.isFinite(raw) && raw >= 40 ? raw : Number.POSITIVE_INFINITY
})()

/**
 * Fallback budget when the model's context window is unknown (~15K tokens).
 * An explicit OPENCODE_WIKI_TOC_BUDGET pins the budget and disables scaling.
 */
export const TOC_CHAR_BUDGET = (() => {
  const raw = Number(process.env["OPENCODE_WIKI_TOC_BUDGET"])
  return Number.isFinite(raw) && raw > 1000 ? raw : 60_000
})()

/**
 * Budget for the injected index, scaled to the model actually in use.
 * A page missing from the index is invisible — the model never learns it
 * exists — so this is sized for discoverability, not token thrift:
 *
 *   1M context   -> 100K tokens -> ~325,000 chars (~2,000 pages)
 *   200K context ->  20K tokens ->  ~65,000 chars   (~400 pages)
 *   32K context  -> 3.2K tokens ->  ~10,400 chars    (~65 pages)
 *
 * memory_status reports usage and warns loudly if anything is ever omitted.
 */
export function tocBudgetFor(contextLimitTokens?: number): number {
  if (process.env["OPENCODE_WIKI_TOC_BUDGET"]) return TOC_CHAR_BUDGET
  if (!contextLimitTokens || !Number.isFinite(contextLimitTokens) || contextLimitTokens <= 0) {
    return TOC_CHAR_BUDGET
  }
  const scaled = Math.floor(contextLimitTokens * TOC_CONTEXT_SHARE * CHARS_PER_TOKEN)
  return Math.min(TOC_CHAR_CEILING, Math.max(TOC_CHAR_FLOOR, scaled))
}

/** Approximate token cost of a rendered index */
export function approxTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN)
}

/** Budget and context window last used by the injection hook (for memory_status) */
let lastUsed = { budget: TOC_CHAR_BUDGET, contextTokens: 0 }
export function setLastUsedBudget(budget: number, contextTokens: number): void {
  lastUsed = { budget, contextTokens }
}
export function getLastUsedBudget(): { budget: number; contextTokens: number } {
  return lastUsed
}

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

/**
 * Resolve a wiki-relative path, refusing anything that escapes the wiki root.
 * Page paths reach us from model-supplied tool arguments, so "../../.ssh/id_rsa"
 * must never resolve. Returns null when the path is unsafe.
 */
export function resolveWikiPath(relPath: string): string | null {
  const root = resolve(getWikiDir())
  const target = resolve(root, relPath)
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

/** Read and parse a single page. Returns null on any failure. */
export function readPage(relPath: string): WikiPage | null {
  try {
    const filePath = resolveWikiPath(relPath)
    if (!filePath || !existsSync(filePath)) return null
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
  // NOTE: no description-length check — writePage truncates instead of
  // rejecting, so an over-long summary can never cost us the body.
  if (page.type === "Project" && !page.codePath) return "Project pages require code_path (the absolute path of the code directory they document)"
  const lines = page.body.split("\n").length
  if (lines > MAX_BODY_LINES) {
    return `body is ${lines} lines — cap is ${MAX_BODY_LINES}. Distill harder: keep reusable patterns, drop session narrative.`
  }
  if (page.body.length > MAX_BODY_CHARS) {
    return (
      `body is ${page.body.length} chars — cap is ${MAX_BODY_CHARS}. Individual lines are too long ` +
      `(pasted logs, minified data?). Summarise them or keep only the meaningful excerpt.`
    )
  }
  return null
}

/**
 * Flatten a value for a single-line quoted frontmatter field. Newlines, tabs
 * and stray quotes would make the page unparseable — and an unparseable page
 * silently disappears from listPages(), the TOC, search and dedup while the
 * file still sits on disk looking correct.
 */
function scalar(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim()
}

/** Serialize a page to markdown with frontmatter */
export function serializePage(page: WikiPage): string {
  let out = "---\n"
  out += `type: ${page.type}\n`
  out += `title: "${scalar(page.title)}"\n`
  out += `description: "${scalar(page.description)}"\n`
  out += `tags: [${page.tags.map((t) => scalar(t).replace(/[[\],]/g, "")).filter(Boolean).join(", ")}]\n`
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

  // Clip an over-long description on a word boundary rather than rejecting
  // the page — see MAX_DESCRIPTION_CHARS.
  if (clean.description.length > MAX_DESCRIPTION_CHARS) {
    const slice = clean.description.slice(0, MAX_DESCRIPTION_CHARS - 1)
    const lastSpace = slice.lastIndexOf(" ")
    clean.description =
      (lastSpace > MAX_DESCRIPTION_CHARS - 40 ? slice.slice(0, lastSpace) : slice).trimEnd() + "…"
    redacted.push("description-truncated")
  }

  const error = validatePage(clean)
  if (error) throw new Error(`Invalid page ${page.relPath}: ${error}`)

  const filePath = resolveWikiPath(clean.relPath)
  if (!filePath) throw new Error(`Invalid page path (escapes the wiki root): ${clean.relPath}`)
  ensureDir(dirname(filePath))
  writeFileSync(filePath, serializePage(clean), "utf-8")
  invalidatePageCache()

  // A page that cannot be read back is a page that has silently vanished from
  // the index, search and dedup. Fail loudly instead.
  if (!readPage(clean.relPath)) {
    throw new Error(
      `Page written but does not parse back — frontmatter is malformed: ${clean.relPath}`
    )
  }
  return redacted
}

const LEADING_DATE = /^(\d{4}-\d{2}-\d{2})-/

/**
 * Split any leading YYYY-MM-DD prefixes off a slug, looping so that already
 * compounded slugs collapse (2026-08-03-2026-05-04-foo -> foo, date 2026-08-03).
 * Distillers routinely embed the incident date in the slug they invent; without
 * this, every harvest prepends today's date again and filenames grow without
 * bound. Returns the first date found so the true incident date can be kept.
 */
export function splitLeadingDate(slug: string): { slug: string; date?: string } {
  let rest = slug
  let date: string | undefined
  for (;;) {
    const m = rest.match(LEADING_DATE)
    if (!m) break
    date ??= m[1]!
    rest = rest.slice(m[0]!.length)
  }
  return rest ? { slug: rest, date } : { slug, date: undefined }
}

/**
 * Short content fingerprint of a page as it exists on disk. memory_recall
 * hands this to the model and memory_write can require it back, so a write
 * that merged against a stale read is rejected instead of silently discarding
 * whatever the janitor wrote in between.
 */
export function pageRevision(relPath: string): string {
  try {
    const filePath = resolveWikiPath(relPath)
    if (!filePath || !existsSync(filePath)) return "none"
    const content = readFileSync(filePath, "utf-8")
    let hash = 5381
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0
    }
    return (hash >>> 0).toString(36)
  } catch {
    return "none"
  }
}

/** Date-stripped slug of a page path, used to match investigations across days */
export function bareSlug(relPath: string): string {
  const file = relPath.split("/").pop()?.replace(/\.md$/, "") ?? relPath
  return splitLeadingDate(file).slug
}

/** Compute the canonical relative path for a page by type */
export function pathFor(type: PageType, slug: string, date?: string): string {
  if (type === "Project") return join("projects", slug, "overview.md")
  if (type === "Topic") return join("topics", `${slug}.md`)
  // Prefer an explicit date, then a date the distiller put in the slug (the
  // real incident date), and only fall back to today (the harvest date).
  const split = splitLeadingDate(slug)
  const prefix = date ?? split.date ?? new Date().toISOString().slice(0, 10)
  return join("investigations", `${prefix}-${split.slug}.md`)
}

/**
 * Find an existing investigation with the same date-stripped slug, regardless
 * of which day it was written. Without this, resolveRelPath computes today's
 * prefix, never matches a page written earlier, and creates a fresh duplicate
 * on every run — investigations could never merge.
 */
export function findInvestigationBySlug(slug: string, pages?: WikiPage[]): WikiPage | null {
  const want = splitLeadingDate(slug).slug
  if (!want) return null
  return (
    (pages ?? listPages()).find((p) => p.type === "Investigation" && bareSlug(p.relPath) === want) ?? null
  )
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
export function deriveTOC(pages?: WikiPage[], budgetChars?: number): string {
  const all = pages ?? listPages()
  if (all.length === 0) return ""
  const budget = budgetChars ?? TOC_CHAR_BUDGET

  const bySlug = (a: WikiPage, b: WikiPage) => a.relPath.localeCompare(b.relPath)
  const topics = all.filter((p) => p.type === "Topic").sort(bySlug)
  const projects = all.filter((p) => p.type === "Project").sort(bySlug)
  // Newest investigations first — recent troubleshooting is likelier relevant
  const investigations = all.filter((p) => p.type === "Investigation").sort((a, b) => b.relPath.localeCompare(a.relPath))

  const sections = [
    { header: `TOPICS — load with memory_recall page="topics/<slug>.md":`, pages: topics },
    { header: `PROJECTS — load with memory_recall page="projects/<slug>/overview.md":`, pages: projects },
    { header: `INVESTIGATIONS — load with memory_recall page="investigations/<name>.md":`, pages: investigations },
  ]
    .filter((s) => s.pages.length > 0)
    .map((s) => ({
      ...s,
      lines: s.pages.map((p) => `- ${tocSlug(p)}: ${trimDesc(p.description)}\n`),
    }))

  // Max-min fair allocation: sections that need less than an equal share take
  // only what they need and hand the remainder back, so a small section can
  // never strand budget that a large one could use. (A naive equal split
  // truncated topics at 1/3 of the budget while total usage sat well under it.)
  const allocations = new Map<string, number>()
  let remaining = budget
  const ordered = [...sections].sort(
    (a, b) => need(a.header, a.lines) - need(b.header, b.lines)
  )
  ordered.forEach((section, i) => {
    const share = Math.floor(remaining / (ordered.length - i))
    const take = Math.min(need(section.header, section.lines), share)
    allocations.set(section.header, take)
    remaining -= take
  })

  let out = ""
  let truncated = 0
  for (const section of sections) {
    const budget = allocations.get(section.header) ?? 0
    let used = section.header.length + 1
    let sectionOut = section.header + "\n"
    for (const line of section.lines) {
      if (used + line.length > budget) {
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
      `(+${truncated} page(s) omitted — index budget reached. Find them with ` +
      `memory_recall query="..."; memory_status reports index health)\n`
  }
  return out.trimEnd()
}

/** Characters a section needs to render in full */
function need(header: string, lines: string[]): number {
  return header.length + 1 + lines.reduce((sum, l) => sum + l.length, 0)
}

/** Clip a description for its TOC line, on a word boundary where possible */
function trimDesc(description: string): string {
  if (description.length <= TOC_DESC_CHARS) return description
  const slice = description.slice(0, TOC_DESC_CHARS - 1)
  const lastSpace = slice.lastIndexOf(" ")
  return (lastSpace > TOC_DESC_CHARS - 30 ? slice.slice(0, lastSpace) : slice).trimEnd() + "…"
}

/** Number of pages omitted from the derived TOC (0 when everything fits) */
export function tocTruncationCount(pages?: WikiPage[], budgetChars?: number): number {
  const all = pages ?? listPages()
  const shown = deriveTOC(all, budgetChars).split("\n").filter((l) => l.startsWith("- ")).length
  return Math.max(0, all.length - shown)
}

export interface DuplicateGroup {
  reason: string
  pages: string[]
}

/**
 * Detect pages that likely describe the same subject. Reported, never acted
 * on automatically — merging is a judgement call for the model or the user.
 *
 * Two signals, both conservative:
 * - Project pages sharing a code_path (always a genuine duplicate)
 * - Pages of the same type whose slugs differ only by a generic suffix/prefix
 *   (overview, notes, guide, setup...) or are equal after removing non-letters
 */
const GENERIC_AFFIXES = ["overview", "notes", "guide", "setup", "config", "info", "docs", "summary", "page"]

export function findDuplicates(pages?: WikiPage[]): DuplicateGroup[] {
  const all = pages ?? listPages()
  const groups: DuplicateGroup[] = []

  // Project pages documenting the same directory
  const byCodePath = new Map<string, string[]>()
  for (const p of all) {
    if (p.type !== "Project" || !p.codePath) continue
    const key = p.codePath.replace(/\/+$/, "")
    byCodePath.set(key, [...(byCodePath.get(key) ?? []), p.relPath])
  }
  for (const [codePath, paths] of byCodePath) {
    if (paths.length > 1) {
      groups.push({ reason: `same code_path (${codePath})`, pages: paths.sort() })
    }
  }

  // Slugs equal after stripping generic affixes and separators
  const byNormalized = new Map<string, string[]>()
  for (const p of all) {
    if (p.type === "Investigation") continue // date-prefixed; expected to differ
    let slug = tocSlug(p).toLowerCase()
    for (const affix of GENERIC_AFFIXES) {
      slug = slug.replace(new RegExp(`[-_]?${affix}$`), "").replace(new RegExp(`^${affix}[-_]?`), "")
    }
    const key = `${p.type}:${slug.replace(/[^a-z0-9]/g, "")}`
    byNormalized.set(key, [...(byNormalized.get(key) ?? []), p.relPath])
  }
  for (const [key, paths] of byNormalized) {
    if (paths.length > 1) {
      const sorted = paths.sort()
      // Skip if already reported via code_path
      if (groups.some((g) => g.pages.join() === sorted.join())) continue
      groups.push({ reason: `near-identical slug (${key.split(":")[1]})`, pages: sorted })
    }
  }

  return groups
}

/**
 * Delete a page. Callers MUST confirm with the user first — the prune tool
 * is dry-run by default and requires an explicit confirm flag.
 * Returns true if a file was removed.
 */
export function deletePage(relPath: string): boolean {
  try {
    const filePath = join(getWikiDir(), relPath)
    if (!existsSync(filePath)) return false
    rmSync(filePath)
    // Clean up an emptied projects/<name>/ directory
    const dir = dirname(filePath)
    if (dir.includes(`${sep}projects${sep}`) || dir.includes("/projects/")) {
      try {
        if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true })
      } catch {}
    }
    invalidatePageCache()
    return true
  } catch {
    return false
  }
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
