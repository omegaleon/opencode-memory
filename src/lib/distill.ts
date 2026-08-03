import { basename } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { WikiPage, PageType } from "./wiki.js"
import {
  listPages,
  readPage,
  writePage,
  pathFor,
  slugify,
  deriveTOC,
  findInvestigationBySlug,
  MAX_BODY_LINES,
} from "./wiki.js"

export interface DistillReport {
  written: string[]
  skipped: string[]
  /** "page: label,label" for any credentials stripped at write time */
  redacted: string[]
}

/** Per-prompt timeout — a stuck distillation must never wedge the janitor */
const PROMPT_TIMEOUT_MS = 5 * 60_000

/** Re-prompt attempts when a page fails validation (body cap, mostly) */
const WRITE_RETRIES = 2

const PAGE_BLOCK_FORMAT =
  "## PAGE: <type>\n" +
  "slug: <kebab-case-slug>\n" +
  "title: <short title>\n" +
  "description: <ONE line, max 200 chars — this becomes the page's index entry>\n" +
  "tags: [tag1, tag2]\n" +
  "code_path: <absolute path — Project pages ONLY, omit otherwise>\n" +
  "<markdown body>\n" +
  "## END"

const DISTILL_SYSTEM =
  "You are a knowledge distiller for an engineering wiki. You receive a transcript " +
  "of a coding/ops session and extract DURABLE, REUSABLE knowledge — the things a " +
  "future session would need. You are ruthless about signal vs. noise.\n\n" +
  "Page types:\n" +
  "- Topic: cross-project operational knowledge (e.g. s3-troubleshooting, cribl, " +
  "docker-on-unraid). Reusable patterns, gotchas, commands, API paths, links. " +
  "NO session narrative.\n" +
  "- Investigation: one-off troubleshooting write-up. Problem, what was tried, " +
  "root cause, fix. Narrative is fine here.\n" +
  "- Project: context for one codebase — architecture, deployment, key decisions, " +
  "current state (open PRs, blockers, next steps). Requires code_path.\n\n" +
  "CRITICAL — DUAL EXTRACTION: an investigation almost always yields technique that " +
  "outlives the incident. Whenever the transcript contains BOTH a specific incident " +
  "AND generalizable technique, emit BOTH pages: the Investigation for the narrative, " +
  "AND a Topic (new or updated) carrying the reusable technique on its own, understandable " +
  "without the incident. Example: debugging missing Slack logs yields an Investigation " +
  "about that outage AND Topic updates on scoping S3 queries by event time vs wall clock. " +
  "Cross-reference them by path in the bodies. Knowledge buried in an incident write-up " +
  "is knowledge lost.\n\n" +
  "What counts as durable: root causes, non-obvious fixes, exact API endpoints/paths, " +
  "required env vars/versions, access patterns (e.g. 'try aws --profile default first'), " +
  "query/scoping techniques, architecture decisions with rationale, deployment procedures, " +
  "links to repos/docs, verbatim error strings worth searching for.\n" +
  "What does NOT: routine edits, generic knowledge any LLM already has, blow-by-blow " +
  "narration, anything you cannot state concretely.\n\n" +
  "Rules that keep the wiki from rotting:\n" +
  "1. An existing page does NOT mean everything about that subject was captured — add " +
  "what is genuinely new.\n" +
  "2. No detail contamination: do not move specifics from one page's subject onto another.\n" +
  "3. No meta-extraction: never write pages about the wiki, this distillation process, " +
  "or the assistant's own behaviour.\n" +
  "4. NEVER record credentials — passwords, API keys, tokens, private keys, connection " +
  "strings with embedded passwords. Record the credential's NAME/location instead " +
  "(e.g. 'token in $SLACK_BOT_TOKEN / 1Password entry X'). Non-secret identifiers " +
  "(account IDs, ARNs, bucket names, hostnames) ARE valuable — keep those.\n" +
  "5. If new information contradicts an existing page, prefer the newer fact and note " +
  "the supersession briefly.\n\n" +
  `Output ONLY page blocks in exactly this format (repeat per page, max body ${MAX_BODY_LINES} lines):\n\n` +
  PAGE_BLOCK_FORMAT +
  "\n\nPrefer UPDATING an existing page (same slug as shown in the index you are given) " +
  "over creating near-duplicates. If the transcript contains nothing durable, output " +
  "exactly: NOTHING TO SAVE\n" +
  "Do not use any tools. Respond with text only."

const MERGE_INSTRUCTION =
  "One of the pages you produced already exists. Below is the CURRENT page content. " +
  "Merge your new knowledge INTO it and output the complete replacement page as a " +
  "single page block (same format as before). Rules: full rewrite, not an append; " +
  "keep still-valid existing content; replace anything your new information supersedes; " +
  `stay under ${MAX_BODY_LINES} body lines by dropping the least reusable material.\n\n` +
  "CURRENT PAGE:\n"

interface ParsedBlock {
  type: PageType
  slug: string
  title: string
  description: string
  tags: string[]
  codePath?: string
  body: string
}

/**
 * Distill a transcript into wiki pages using a child session for the LLM work.
 * Merging into existing pages is a follow-up prompt in the same child session
 * (read-merge-rewrite, enforced here rather than trusted to prose rules).
 *
 * Returns null if the child session could not be created or never answered.
 */
export async function distillTranscript(
  client: PluginInput["client"],
  opts: {
    transcript: string
    directory: string
    parentSessionID?: string
    /** Session the knowledge came from — recorded as page provenance */
    sourceSessionID?: string
    /** Called with the child session ID so callers can exclude it from harvesting */
    onPluginSession?: (sessionID: string) => void
  }
): Promise<DistillReport | null> {
  try {
    const pages = listPages()
    const toc = deriveTOC(pages)
    const candidates = selectCandidates(pages, opts.transcript, opts.directory)

    // Child session keeps distillation out of the user's context entirely.
    // parentID makes it a sub-session (not shown in the main session list).
    const { data: child } = await client.session.create({
      body: {
        parentID: opts.parentSessionID,
        title: "memory: distillation",
      },
    })
    if (!child?.id) return null
    opts.onPluginSession?.(child.id)

    const userPrompt =
      (toc ? `EXISTING WIKI INDEX (update these instead of duplicating):\n${toc}\n\n` : "") +
      (candidates
        ? "MOST LIKELY PAGES TO UPDATE (current full content — merge into these " +
          `rather than creating new pages when the subject matches):\n${candidates}\n\n`
        : "") +
      `SESSION WORKING DIRECTORY: ${opts.directory}\n\n` +
      `TRANSCRIPT:\n${opts.transcript}`

    const reply = await promptWithTimeout(client, child.id, DISTILL_SYSTEM, userPrompt)
    if (reply == null) return null
    if (/NOTHING TO SAVE/.test(reply)) return { written: [], skipped: [], redacted: [] }

    const report: DistillReport = { written: [], skipped: [], redacted: [] }

    for (const block of parseBlocks(reply)) {
      const relPath = resolveRelPath(block)
      const existing = readPage(relPath)

      let final = block
      if (existing) {
        // Read-merge-rewrite: same child session already has the new content
        // in context; give it the current page and ask for the full merge.
        const mergeReply = await promptWithTimeout(
          client,
          child.id,
          DISTILL_SYSTEM,
          MERGE_INSTRUCTION + pageToBlockText(existing, block.type, block.slug)
        )
        const merged = mergeReply ? parseBlocks(mergeReply)[0] : undefined
        if (merged) final = { ...merged, type: block.type, slug: block.slug }
      }

      // Provenance: accumulate source sessions, newest last, bounded
      const sources = [...(existing?.sourceSessions ?? [])]
      if (opts.sourceSessionID && !sources.includes(opts.sourceSessionID)) {
        sources.push(opts.sourceSessionID)
      }

      const toPage = (b: ParsedBlock, path: string): WikiPage => ({
        relPath: path,
        type: b.type,
        title: b.title,
        description: b.description,
        tags: b.tags,
        timestamp: new Date().toISOString(),
        codePath: b.codePath ?? existing?.codePath,
        sourceSessions: sources.slice(-10),
        body: b.body,
      })

      // Write with retry: a validation rejection (almost always the body cap
      // on a merge) used to silently discard the page. Feed the actual error
      // back to the child session — which still holds the content — and ask
      // for a corrected version, splitting overflow onto follow-up pages
      // rather than deleting it.
      let candidate: ParsedBlock | undefined = final
      let candidatePath = relPath
      let lastError = ""

      for (let attempt = 0; attempt <= WRITE_RETRIES; attempt++) {
        if (!candidate) break
        try {
          const redacted = writePage(toPage(candidate, candidatePath))
          report.written.push(candidatePath)
          if (redacted.length > 0) {
            report.redacted.push(`${candidatePath}: ${redacted.join(", ")}`)
          }
          lastError = ""
          break
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
          if (attempt === WRITE_RETRIES) break

          const fixReply = await promptWithTimeout(
            client,
            child.id,
            DISTILL_SYSTEM,
            `The page you produced was REJECTED: ${lastError}\n\n` +
              `Output the SAME page again as a page block, corrected. Do NOT abandon ` +
              `content: move whatever does not fit onto a separate follow-up page (its own ` +
              `page block with a distinct slug) instead of deleting it, and keep every ` +
              `concrete identifier, command, path and version string.`
          )
          const fixed = fixReply ? parseBlocks(fixReply) : []
          if (fixed.length === 0) break

          candidate = { ...fixed[0]!, type: candidate.type }
          candidatePath = resolveRelPath(candidate)

          // Any additional blocks are overflow pages — write them too
          for (const overflow of fixed.slice(1)) {
            const overflowPath = resolveRelPath(overflow)
            try {
              const r = writePage(toPage(overflow, overflowPath))
              report.written.push(overflowPath)
              if (r.length > 0) report.redacted.push(`${overflowPath}: ${r.join(", ")}`)
            } catch (e) {
              report.skipped.push(`${overflowPath}: ${e instanceof Error ? e.message : e}`)
            }
          }
        }
      }

      if (lastError) {
        report.skipped.push(`${candidatePath}: ${lastError}`)
      }
    }

    return report
  } catch {
    return null
  }
}

/** How many existing pages to show the distiller in full before it writes */
const MAX_CANDIDATES = 4
/** Character cap on the candidate block */
const CANDIDATE_CHAR_CAP = 12_000

/**
 * Pick the existing pages most likely to be the right merge targets and render
 * them in full for the distillation prompt. The TOC alone tells the model a
 * page EXISTS; showing the actual content is what makes it merge instead of
 * writing a near-duplicate (mem0's "context lookup" stage — the proactive
 * version of the code_path identity fix).
 *
 * Scoring is deliberately cheap: token overlap between the transcript and each
 * page's title/description/tags, plus a strong bonus for the project page that
 * owns the session's working directory.
 */
function selectCandidates(pages: WikiPage[], transcript: string, directory: string): string {
  if (pages.length === 0) return ""

  // Sample the transcript — matching against the whole thing is needless work
  const haystack = transcript.slice(0, 20_000).toLowerCase()
  const scored = pages.map((page) => {
    const terms = [
      ...page.title.toLowerCase().split(/[^a-z0-9]+/),
      ...page.description.toLowerCase().split(/[^a-z0-9]+/),
      ...page.tags,
    ].filter((t) => t.length > 3)

    let score = 0
    for (const term of new Set(terms)) {
      if (haystack.includes(term)) score++
    }
    // The project page owning this directory is almost always a merge target
    if (page.type === "Project" && page.codePath && directory.startsWith(page.codePath)) {
      score += 10
    }
    return { page, score }
  })

  const top = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)

  let out = ""
  for (const { page } of top) {
    const rendered = pageToBlockText(page, page.type, tocSlugOf(page)) + "\n\n"
    if (out.length + rendered.length > CANDIDATE_CHAR_CAP) break
    out += rendered
  }
  return out.trim()
}

/** Slug portion of a page path (mirrors the TOC's naming) */
function tocSlugOf(page: WikiPage): string {
  if (page.type === "Project") return page.relPath.split("/")[1] ?? page.relPath
  const file = page.relPath.split("/").pop() ?? page.relPath
  return file.replace(/\.md$/, "")
}

/**
 * Resolve the on-disk path for a distilled block. For Project pages the
 * identity is code_path, NOT the model-chosen slug: if any existing project
 * page documents the same code directory, the block merges into that page,
 * and new project pages are slugged from the directory basename. This makes
 * duplicate project pages structurally impossible regardless of what slug
 * the distiller invents (observed failure: "jira-remindme" and
 * "jira-remindme-overview" created for one repo 36s apart).
 * Re-reads the page list fresh so pages written earlier in the same run
 * are visible.
 */
function resolveRelPath(block: ParsedBlock): string {
  if (block.type === "Project" && block.codePath) {
    const codePath = block.codePath.replace(/\/+$/, "")
    const match = listPages().find(
      (p) => p.type === "Project" && p.codePath?.replace(/\/+$/, "") === codePath
    )
    if (match) return match.relPath
    return pathFor("Project", slugify(basename(codePath)))
  }
  // Investigations are date-prefixed, so a same-subject page written on an
  // earlier day would never be found by path. Match on the date-stripped slug
  // so investigations can merge instead of duplicating on every run.
  if (block.type === "Investigation") {
    const match = findInvestigationBySlug(block.slug)
    if (match) return match.relPath
  }
  return pathFor(block.type, block.slug)
}

/** Prompt a session and return concatenated text parts, or null on timeout/failure */
async function promptWithTimeout(
  client: PluginInput["client"],
  sessionID: string,
  system: string,
  text: string
): Promise<string | null> {
  try {
    const result = await Promise.race([
      client.session.prompt({
        path: { id: sessionID },
        body: {
          system,
          parts: [{ type: "text", text }],
        },
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PROMPT_TIMEOUT_MS)),
    ])
    if (!result || !("data" in result) || !result.data) return null

    const parts = (result.data as any).parts ?? []
    const texts = parts
      .filter((p: any) => p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
    return texts.length > 0 ? texts.join("\n") : null
  } catch {
    return null
  }
}

/** Parse "## PAGE: <type> ... ## END" blocks out of a distiller reply */
export function parseBlocks(reply: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  const regex = /^## PAGE:\s*(\w+)\s*\n([\s\S]*?)^## END/gm
  let match: RegExpExecArray | null

  while ((match = regex.exec(reply)) !== null) {
    const type = normalizeType(match[1]!)
    if (!type) continue

    const lines = match[2]!.split("\n")
    const fields: Record<string, string> = {}
    let bodyStart = 0

    // Header lines are key: value until the first non-matching line
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i]!.match(/^(slug|title|description|tags|code_path):\s*(.*)$/)
      if (!kv) {
        if (lines[i]!.trim() === "") continue
        bodyStart = i
        break
      }
      fields[kv[1]!] = kv[2]!.trim()
      bodyStart = i + 1
    }

    const body = lines.slice(bodyStart).join("\n").trim()
    if (!fields["title"] || !body) continue

    blocks.push({
      type,
      slug: slugify(fields["slug"] ?? fields["title"]!),
      title: fields["title"]!,
      description: fields["description"] ?? "",
      tags: (fields["tags"] ?? "")
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      codePath: fields["code_path"] || undefined,
      body,
    })
  }
  return blocks
}

function normalizeType(raw: string): PageType | null {
  const lower = raw.toLowerCase()
  if (lower === "topic") return "Topic"
  if (lower === "investigation") return "Investigation"
  if (lower === "project") return "Project"
  return null
}

/** Render an existing page in block format for the merge prompt */
function pageToBlockText(page: WikiPage, type: PageType, slug: string): string {
  let out = `## PAGE: ${type}\n`
  out += `slug: ${slug}\n`
  out += `title: ${page.title}\n`
  out += `description: ${page.description}\n`
  out += `tags: [${page.tags.join(", ")}]\n`
  if (page.codePath) out += `code_path: ${page.codePath}\n`
  out += `${page.body}\n## END`
  return out
}
