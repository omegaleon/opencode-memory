import { tool } from "@opencode-ai/plugin/tool"
import type { PluginInput } from "@opencode-ai/plugin"
import { startBootstrap, bootstrapStatus } from "../lib/bootstrap-runner.js"
import { cancelJob } from "../lib/job-runner.js"

export function createMemoryBootstrapTool(client: PluginInput["client"]) {
  return tool({
    description:
      "Seed the wiki from this machine's ENTIRE OpenCode session history. " +
      "Runs DETACHED: action=\"start\" kicks off a background run and returns " +
      "immediately — the session stays free for other work. Each historical session " +
      "is distilled into wiki pages by a child session, checkpointed as it goes. " +
      "action=\"status\" returns instant progress (poll this when the user asks how " +
      "it's going). action=\"cancel\" stops the run between sessions; restarting " +
      "resumes where it left off. Idempotent — processed sessions are never redone. " +
      "Run on a fresh install to bootstrap memory.",
    args: {
      action: tool.schema
        .enum(["start", "status", "cancel"])
        .optional()
        .describe("start (default): begin a background run. status: instant progress report. cancel: stop the active run."),
      limit: tool.schema
        .number()
        .optional()
        .describe("start only: cap how many sessions this run processes. Default: all pending."),
      min_messages: tool.schema
        .number()
        .optional()
        .describe("start only: skip sessions with fewer messages than this. Default: 2 (skips empty shells only)."),
    },
    async execute(args, context) {
      const action = args.action ?? "start"
      if (action === "status") return bootstrapStatus()
      if (action === "cancel") return cancelJob()
      return startBootstrap(client, context.sessionID, {
        limit: args.limit,
        minMessages: args.min_messages,
      })
    },
  })
}
