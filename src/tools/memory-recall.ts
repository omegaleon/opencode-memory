import { tool } from "@opencode-ai/plugin/tool"
import { listPages, readPage, serializePage, pageRevision } from "../lib/wiki.js"

/** Cap tool output — recall must never become a context bomb */
const OUTPUT_CHAR_CAP = 20_000
const MAX_SEARCH_RESULTS = 10

export function createMemoryRecallTool() {
  return tool({
    description:
      "Recall knowledge from the persistent wiki. " +
      "With `page`, returns that page's full content (paths are shown in the [MEMORY] index). " +
      "With `query`, searches titles/descriptions/tags/bodies and returns matching pages. " +
      "With neither, lists every page with its one-line description. " +
      "Use this before claiming you lack knowledge or access for a task.",
    args: {
      page: tool.schema
        .string()
        .optional()
        .describe("Page path relative to the wiki root, e.g. 'topics/s3-troubleshooting.md'."),
      query: tool.schema
        .string()
        .optional()
        .describe("Keywords to search across all pages (titles, descriptions, tags, bodies)."),
      type: tool.schema
        .enum(["Topic", "Project", "Investigation"])
        .optional()
        .describe("Restrict results to one page type."),
      tag: tool.schema
        .string()
        .optional()
        .describe("Restrict results to pages carrying this tag."),
    },
    async execute(args) {
      // Load one page in full
      if (args.page) {
        const relPath = args.page.trim()
        const page = readPage(relPath)
        if (!page) {
          return `No page found at: ${args.page}\nCall memory_recall with no args to list available pages.`
        }
        return truncate(
          `revision: ${pageRevision(relPath)}  (pass as expect_revision if you update this page)\n\n` +
            serializePage(page)
        )
      }

      let pages = listPages()
      if (pages.length === 0) {
        return "The wiki is empty. Pages are created by the background janitor, memory_write, or memory_bootstrap."
      }

      // Optional filters narrow the candidate set before searching/listing
      const filters: string[] = []
      if (args.type) {
        pages = pages.filter((p) => p.type === args.type)
        filters.push(`type=${args.type}`)
      }
      if (args.tag) {
        const tag = args.tag.trim().toLowerCase()
        pages = pages.filter((p) => p.tags.includes(tag))
        filters.push(`tag=${tag}`)
      }
      if (pages.length === 0) {
        return `No pages match filter(s): ${filters.join(", ")}`
      }

      // Keyword search
      if (args.query) {
        const keywords = args.query
          .toLowerCase()
          .split(/[\s,]+/)
          .filter((k) => k.length > 1)

        const scored = pages
          .map((page) => {
            const haystack = [page.title, page.description, page.tags.join(" "), page.body, page.relPath]
              .join(" ")
              .toLowerCase()
            let score = 0
            for (const kw of keywords) {
              if (haystack.includes(kw)) score++
            }
            return { page, score }
          })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_SEARCH_RESULTS)

        if (scored.length === 0) {
          return `No pages match: ${args.query}\nTotal pages: ${pages.length}. Call with no args to list them.`
        }

        // Single strong match: return it in full; otherwise list summaries
        if (scored.length === 1) {
          return truncate(serializePage(scored[0]!.page))
        }
        const lines = [`${scored.length} matching page(s) — load one with memory_recall(page="<path>"):`, ""]
        for (const { page } of scored) {
          lines.push(`- ${page.relPath} [${page.type}] — ${page.description}`)
        }
        return lines.join("\n")
      }

      // No args: full listing
      const lines = [`${pages.length} page(s) in the wiki:`, ""]
      for (const page of pages) {
        lines.push(`- ${page.relPath} [${page.type}] — ${page.description}`)
      }
      return truncate(lines.join("\n"))
    },
  })
}

function truncate(text: string): string {
  return text.length > OUTPUT_CHAR_CAP ? text.slice(0, OUTPUT_CHAR_CAP) + "\n…(truncated)" : text
}
