import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { listPages, deriveTOC, findProjectPage } from "../lib/wiki.js"

/** Cap on the injected project overview (chars) — overviews are size-capped
 * on disk anyway, this is a second line of defense */
const OVERVIEW_CHAR_CAP = 6_000

/** Re-scan the wiki at most this often — readdir is cheap but not free */
const SCAN_TTL_MS = 60_000

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
  let cached: { toc: string; overview: string } | null = null
  let cachedAt = 0

  return async (_input, output) => {
    try {
      if (!cached || Date.now() - cachedAt > SCAN_TTL_MS) {
        const pages = listPages()
        const toc = deriveTOC(pages)
        const project = findProjectPage(directory, pages)
        let overview = ""
        if (project) {
          overview =
            `[MEMORY] Project context for ${project.codePath} (${project.relPath}):\n` +
            truncate(project.body, OVERVIEW_CHAR_CAP)
        }
        cached = { toc, overview }
        cachedAt = Date.now()
      }

      if (cached.toc) {
        output.system.push(
          "[MEMORY] Wiki pages available — load one with memory_recall(page=\"<path>\"):\n" +
          cached.toc +
          "\nBefore claiming you lack knowledge or access for a task (credentials, " +
          "APIs, debugging steps, deployment details), check relevant pages via memory_recall."
        )
      }
      if (cached.overview) {
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
