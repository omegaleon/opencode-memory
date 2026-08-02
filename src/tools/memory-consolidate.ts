import { tool } from "@opencode-ai/plugin/tool"
import type { PluginInput } from "@opencode-ai/plugin"
import { listPages, readPage } from "../lib/wiki.js"
import { distillTranscript } from "../lib/distill.js"
import { readState, writeState } from "../lib/state.js"
import { maybeCommit } from "../lib/git.js"

/** Investigations processed per call — each is an LLM round-trip */
const DEFAULT_LIMIT = 5

export function createMemoryConsolidateTool(client: PluginInput["client"], directory: string) {
  return tool({
    description:
      "Harvest reusable technique out of existing Investigation pages into Topic pages. " +
      "An investigation records one incident, but usually also contains knowledge that " +
      "outlives it (query techniques, scoping rules, tool flags, access patterns). This " +
      "sweep re-reads investigations and promotes that knowledge into standalone Topics, " +
      "so it is usable in unrelated sessions. " +
      "NOTHING IS DELETED — investigations are left intact; topics are created or merged. " +
      "Idempotent: already-consolidated investigations are skipped. Run occasionally, or " +
      "after a bootstrap that produced many investigations.",
    args: {
      limit: tool.schema
        .number()
        .optional()
        .describe(`How many investigations to process this call. Default: ${DEFAULT_LIMIT}.`),
      page: tool.schema
        .string()
        .optional()
        .describe("Consolidate one specific investigation by path, e.g. 'investigations/2026-08-01-slack-logs.md'."),
    },
    async execute(args, context) {
      const state = readState()
      const done = new Set(state.consolidated ?? [])

      let targets = args.page
        ? [readPage(args.page.trim())].filter((p): p is NonNullable<typeof p> => p != null)
        : listPages()
            .filter((p) => p.type === "Investigation" && !done.has(p.relPath))
            .sort((a, b) => b.relPath.localeCompare(a.relPath))
            .slice(0, args.limit ?? DEFAULT_LIMIT)

      if (targets.length === 0) {
        const total = listPages().filter((p) => p.type === "Investigation").length
        return args.page
          ? `No investigation page found at: ${args.page}`
          : `Nothing to consolidate. ${total} investigation(s) exist, all already processed.`
      }

      const results: string[] = []
      let topicsWritten = 0

      for (const investigation of targets) {
        // Feed the investigation to the distiller as source material. It is
        // told to extract ONLY generalizable technique — the investigation
        // itself stays exactly as it is.
        const source =
          `The following is an existing Investigation page from the wiki.\n` +
          `Extract ONLY the durable, generalizable technique from it into Topic pages ` +
          `(query/scoping techniques, tool flags, access patterns, gotchas, exact ` +
          `endpoints) so the knowledge is usable in sessions unrelated to this incident.\n` +
          `Write the Topic content so it stands alone WITHOUT the incident narrative. ` +
          `Do NOT emit an Investigation page — that page already exists at ` +
          `${investigation.relPath} and must not be modified. Reference it from the Topic ` +
          `body as the source. If the investigation contains no generalizable technique, ` +
          `output exactly: NOTHING TO SAVE\n\n` +
          `PAGE PATH: ${investigation.relPath}\n` +
          `TITLE: ${investigation.title}\n\n` +
          investigation.body

        const report = await distillTranscript(client, {
          transcript: source,
          directory,
          parentSessionID: context.sessionID,
          onPluginSession: (id) => {
            const s = readState()
            s.pluginSessions.push(id)
            writeState(s)
          },
        })

        if (!report) {
          results.push(`- ${investigation.relPath}: FAILED (will retry next run)`)
          continue
        }

        // Guard: never let consolidation rewrite the investigation itself
        const topics = report.written.filter((p) => p !== investigation.relPath)
        topicsWritten += topics.length

        const s = readState()
        s.consolidated = [...(s.consolidated ?? []), investigation.relPath]
        writeState(s)

        results.push(
          `- ${investigation.relPath}: ` +
            (topics.length > 0 ? `promoted to ${topics.join(", ")}` : "no generalizable technique") +
            (report.redacted.length > 0 ? ` [redacted: ${report.redacted.join("; ")}]` : "")
        )
      }

      if (topicsWritten > 0) {
        maybeCommit(`memory: consolidate ${targets.length} investigation(s) into ${topicsWritten} topic write(s)`)
      }

      const remaining = listPages().filter(
        (p) => p.type === "Investigation" && !new Set(readState().consolidated ?? []).has(p.relPath)
      ).length

      return [
        `Consolidated ${targets.length} investigation(s) — ${topicsWritten} topic write(s). No investigations were modified or deleted.`,
        ...results,
        "",
        remaining > 0
          ? `${remaining} investigation(s) not yet consolidated. Call memory_consolidate again to continue.`
          : "All investigations have been consolidated.",
      ].join("\n")
    },
  })
}
