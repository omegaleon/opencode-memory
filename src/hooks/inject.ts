import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { listPages, deriveTOC, findProjectPage, tocBudgetFor, setLastUsedBudget, tocTruncationCount } from "../lib/wiki.js"
import { readState } from "../lib/state.js"

/** Cap on the injected project overview (chars) — overviews are size-capped
 * on disk anyway, this is a second line of defense */
const OVERVIEW_CHAR_CAP = 6_000

/** Re-scan the wiki at most this often — readdir is cheap but not free */
const SCAN_TTL_MS = 60_000

/** Identifies our block in the system array (idempotence + diagnostics) */
const INDEX_MARKER = "[MEMORY] Persistent wiki index:\n"

/** Chars actually injected on the last request — reported by memory_status */
let lastInjectedChars = 0
export function getLastInjectedChars(): number {
  return lastInjectedChars
}

/**
 * Inject the always-available memory surface into the system prompt:
 * 1. The derived TOC (one line per topic/project, hard character budget)
 * 2. The recall rule — ships with the plugin, no AGENTS.md edits needed
 * 3. The matching Project overview when the session cwd is inside a
 *    documented project (deterministic code_path prefix match)
 *
 * This is the ONLY always-loaded cost of the plugin (~600-1500 tokens).
 * Everything else is pulled on demand via memory_recall.
 */
export function createInjectHook(directory: string): Hooks["experimental.chat.system.transform"] {
  let cached: { toc: string; overview: string; budget: number } | null = null
  let cachedAt = 0

  return async (input, output) => {
    try {
      // Index budget scales with the model actually in use (10% of its context
      // window by default), so a 1M-token model gets a far larger index than a
      // 200K one instead of both sharing one hardcoded number.
      const contextTokens = (input as any)?.model?.limit?.context ?? 0
      const budget = tocBudgetFor(contextTokens)
      setLastUsedBudget(budget, contextTokens)

      if (!cached || cached.budget !== budget || Date.now() - cachedAt > SCAN_TTL_MS) {
        const pages = listPages()

        // Investigations whose reusable technique has been promoted into
        // topics are dropped from the index: the durable part is already
        // listed under TOPICS, so listing the incident too costs index space
        // for a second copy. The file stays on disk and stays searchable via
        // memory_recall — this bounds index growth without losing anything.
        const consolidated = new Set(readState().consolidated ?? [])
        const demoted = pages.filter((p) => p.type === "Investigation" && consolidated.has(p.relPath))
        const indexPages = pages.filter((p) => !demoted.includes(p))

        let toc = deriveTOC(indexPages, budget)
        if (toc && demoted.length > 0) {
          toc +=
            `\n(${demoted.length} older investigation(s) not listed — their reusable technique ` +
            `is in the topics above; search the originals with memory_recall query="...")`
        }
        // The index may not list everything. Tell the model explicitly, or it
        // will treat the list as exhaustive and conclude knowledge is absent
        // when it is merely unlisted.
        const omitted = tocTruncationCount(indexPages, budget)
        if (toc && omitted > 0) {
          toc +=
            `\nIMPORTANT: this index is INCOMPLETE — ${omitted} page(s) exist that are not listed ` +
            `above. Never conclude the wiki lacks something based on this list alone; ` +
            `run memory_recall query="<keywords>" to search the full wiki.`
        }
        const project = findProjectPage(directory, pages)
        let overview = ""
        if (project) {
          overview =
            `[MEMORY] Project context for ${project.codePath} (${project.relPath}):\n` +
            truncate(project.body, OVERVIEW_CHAR_CAP)
        }
        cached = { toc, overview, budget }
        cachedAt = Date.now()
      }

      // Idempotence guard: if the host reuses the system array across turns,
      // an unconditional push would re-inject the whole index every request
      // and compound it. Never assume the array is fresh.
      const alreadyInjected = output.system.some((s) => s.startsWith(INDEX_MARKER))

      if (cached.toc && !alreadyInjected) {
        const block =
          INDEX_MARKER +
          cached.toc +
          "\nIf the current task involves any topic listed above, load that page with " +
          "memory_recall BEFORE answering — wiki pages contain environment-specific " +
          "details (exact endpoints, gotchas, access patterns) that override general " +
          "knowledge. Also check relevant pages before claiming you lack knowledge or " +
          "access for a task (credentials, APIs, debugging steps, deployment details)."
        output.system.push(block)
        lastInjectedChars = block.length + cached.overview.length
      }
      if (cached.overview && !alreadyInjected) {
        output.system.push(cached.overview)
      }
    } catch {
      // Never block the host application
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n…(truncated — memory_recall for full page)" : text
}
