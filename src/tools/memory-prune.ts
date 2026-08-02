import { tool } from "@opencode-ai/plugin/tool"
import { listPages, readPage, deletePage, findDuplicates, serializePage } from "../lib/wiki.js"
import { maybeCommit } from "../lib/git.js"

export function createMemoryPruneTool() {
  return tool({
    description:
      "Report duplicate/overlapping wiki pages, and delete a page once the user has " +
      "approved it. DRY RUN BY DEFAULT: called without confirm=true it only reports " +
      "what would be removed and returns the page's full content for review. " +
      "Deletion is permanent (recoverable only if the wiki is a git repo), so ALWAYS " +
      "show the user the page content and get an explicit yes before passing " +
      "confirm=true. Typical cleanup: merge two duplicate pages with memory_write, " +
      "then prune the leftover.",
    args: {
      page: tool.schema
        .string()
        .optional()
        .describe("Page to inspect/delete, e.g. 'projects/jira-remindme-overview/overview.md'. Omit to list duplicates only."),
      confirm: tool.schema
        .boolean()
        .optional()
        .describe("Set true ONLY after the user has explicitly approved deleting this page. Default false = dry run."),
    },
    async execute(args) {
      // No page given: report duplicate candidates
      if (!args.page) {
        const groups = findDuplicates()
        if (groups.length === 0) {
          return `No duplicate or overlapping pages detected across ${listPages().length} page(s).`
        }
        const lines = [
          `${groups.length} possible duplicate group(s) — review before acting:`,
          "",
        ]
        for (const g of groups) {
          lines.push(`[${g.reason}]`)
          for (const p of g.pages) {
            const page = readPage(p)
            lines.push(`  - ${p}${page ? ` — ${page.body.split("\n").length} lines, ${page.description}` : ""}`)
          }
          lines.push("")
        }
        lines.push(
          "To resolve: load both pages with memory_recall, write the merged content to the " +
            "page you are KEEPING via memory_write, then call memory_prune with the leftover " +
            "page and confirm=true after the user approves."
        )
        return lines.join("\n")
      }

      const relPath = args.page.trim()
      const page = readPage(relPath)
      if (!page) return `No page found at: ${relPath}`

      if (!args.confirm) {
        return [
          `DRY RUN — nothing deleted. This would permanently remove:`,
          ``,
          `  ${relPath}  (${page.body.split("\n").length} body lines)`,
          ``,
          `Full content for review:`,
          `---`,
          serializePage(page),
          `---`,
          ``,
          `Show this to the user and get an explicit yes. If any knowledge here is not ` +
            `already in the page you are keeping, merge it first with memory_write. ` +
            `Then call memory_prune again with confirm=true.`,
        ].join("\n")
      }

      const removed = deletePage(relPath)
      if (!removed) return `Failed to delete ${relPath} (already gone?).`

      maybeCommit(`memory: prune ${relPath}`)
      return `Deleted ${relPath}. ${listPages().length} page(s) remain.`
    },
  })
}
