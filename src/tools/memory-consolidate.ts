import { tool } from "@opencode-ai/plugin/tool"
import type { PluginInput } from "@opencode-ai/plugin"
import { startConsolidate, consolidateStatus } from "../lib/consolidate-runner.js"
import { cancelJob } from "../lib/job-runner.js"

export function createMemoryConsolidateTool(client: PluginInput["client"], directory: string) {
  return tool({
    description:
      "Harvest reusable technique out of existing Investigation pages into Topic pages. " +
      "An investigation records one incident, but usually also contains knowledge that " +
      "outlives it (query techniques, scoping rules, tool flags, access patterns); this " +
      "sweep promotes that knowledge into standalone Topics so it is usable in unrelated " +
      "sessions. NOTHING IS DELETED — investigations are left intact. " +
      "Runs DETACHED: action=\"start\" returns immediately and works in the background, " +
      "so the session stays free. action=\"status\" for instant progress, action=\"cancel\" " +
      "to stop between items. Idempotent — already-consolidated investigations are skipped.",
    args: {
      action: tool.schema
        .enum(["start", "status", "cancel"])
        .optional()
        .describe("start (default): begin a background sweep. status: instant progress. cancel: stop the active run."),
      limit: tool.schema
        .number()
        .optional()
        .describe("start only: cap how many investigations this run processes. Default: all pending."),
      page: tool.schema
        .string()
        .optional()
        .describe("start only: consolidate one specific investigation, e.g. 'investigations/2026-08-01-slack-logs.md'."),
    },
    async execute(args, context) {
      const action = args.action ?? "start"
      if (action === "status") return consolidateStatus()
      if (action === "cancel") return cancelJob()
      return startConsolidate(client, context.sessionID, directory, {
        limit: args.limit,
        page: args.page,
      })
    },
  })
}
