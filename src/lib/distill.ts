import { basename } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { WikiPage, PageType } from "./wiki.js"
import { listPages, readPage, writePage, pathFor, slugify, deriveTOC, MAX_BODY_LINES } from "./wiki.js"

export interface DistillReport {
  written: string[]
  skipped: string[]
}

/** Per-prompt timeout — a stuck distillation must never wedge the janitor */
const PROMPT_TIMEOUT_MS = 5 * 60_000

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
  "What counts as durable: root causes, non-obvious fixes, exact API endpoints/paths, " +
  "required env vars/versions, access patterns (e.g. 'try aws --profile default first'), " +
  "architecture decisions with rationale, deployment procedures, links to repos/docs.\n" +
  "What does NOT: routine edits, generic knowledge any LLM already has, blow-by-blow " +
  "narration, anything you cannot state concretely.\n\n" +
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
    /** Called with the child session ID so callers can exclude it from harvesting */
    onPluginSession?: (sessionID: string) => void
  }
): Promise<DistillReport | null> {
  try {
    const pages = listPages()
    const toc = deriveTOC(pages)

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
      `SESSION WORKING DIRECTORY: ${opts.directory}\n\n` +
      `TRANSCRIPT:\n${opts.transcript}`

    const reply = await promptWithTimeout(client, child.id, DISTILL_SYSTEM, userPrompt)
    if (reply == null) return null
    if (/NOTHING TO SAVE/.test(reply)) return { written: [], skipped: [] }

    const report: DistillReport = { written: [], skipped: [] }

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

      try {
        const page: WikiPage = {
          relPath,
          type: final.type,
          title: final.title,
          description: final.description,
          tags: final.tags,
          timestamp: new Date().toISOString(),
          codePath: final.codePath ?? existing?.codePath,
          body: final.body,
        }
        writePage(page)
        report.written.push(relPath)
      } catch (err) {
        report.skipped.push(`${relPath}: ${err instanceof Error ? err.message : err}`)
      }
    }

    return report
  } catch {
    return null
  }
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
