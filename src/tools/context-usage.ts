import { tool } from "@opencode-ai/plugin/tool"
import type { PluginInput } from "@opencode-ai/plugin"
import { getContextUsage } from "../lib/context.js"

export function createContextUsageTool(client: PluginInput["client"]) {
  return tool({
    description:
      "Check current context window usage — returns token count, percentage used, and model context limit. " +
      "Call this to understand how much context remains before compaction.",
    args: {},
    async execute(_args, context) {
      const info = await getContextUsage(client, context.sessionID)

      if (!info) {
        return "Unable to retrieve context usage. No assistant messages with token data found."
      }

      const lines = [
        `Context Usage: ${info.tokens.total.toLocaleString()} / ${info.model.contextLimit.toLocaleString()} tokens (${info.percentage}%)`,
        "",
        "Breakdown:",
        `  Input:     ${info.tokens.input.toLocaleString()}`,
        `  Output:    ${info.tokens.output.toLocaleString()}`,
        `  Reasoning: ${info.tokens.reasoning.toLocaleString()}`,
        `  Cache Read:  ${info.tokens.cacheRead.toLocaleString()}`,
        `  Cache Write: ${info.tokens.cacheWrite.toLocaleString()}`,
        "",
        `Model: ${info.model.id} (${info.model.providerID})`,
        `Context Limit: ${info.model.contextLimit.toLocaleString()} tokens`,
      ]

      if (info.percentage >= 80) {
        lines.push(
          "",
          "WARNING: Context usage is high. Compaction may trigger soon.",
          "Consider using memory_save to preserve important session context."
        )
      } else if (info.percentage >= 60) {
        lines.push(
          "",
          "Note: Context usage is moderate. Consider saving important context with memory_save."
        )
      }

      return lines.join("\n")
    },
  })
}
