import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { getContextUsage } from "../lib/context.js"
import type { SessionTracker } from "./events.js"

const AUTO_SAVE_INTERVAL = 10_000 // Prompt LLM to save every 10K token increase

/**
 * Inject context usage warnings and save reminders into the system prompt.
 * Fires at 10K token intervals and at 60%/80% context usage thresholds.
 */
export function createSystemHook(
  client: PluginInput["client"],
  tracker: SessionTracker
): Hooks["experimental.chat.system.transform"] {
  return async (input, output) => {
    const sessionID = (input as any).sessionID ?? tracker.currentSessionID
    if (!sessionID) return

    const usage = await getContextUsage(client, sessionID)
    if (!usage) return

    const tokenGrowth = usage.tokens.total - tracker.lastSavedTokens

    if (usage.percentage >= 80) {
      output.system.push(
        `[MEMORY PLUGIN] Context usage: ${usage.percentage}% (${usage.tokens.total.toLocaleString()} / ${usage.model.contextLimit.toLocaleString()} tokens). ` +
        `Compaction is imminent. Call memory_save NOW with a high-quality summary before context is lost. Do NOT use project_path.`
      )
      tracker.lastSavedTokens = usage.tokens.total
    } else if (usage.percentage >= 60) {
      output.system.push(
        `[MEMORY PLUGIN] Context usage: ${usage.percentage}% (${usage.tokens.total.toLocaleString()} / ${usage.model.contextLimit.toLocaleString()} tokens). ` +
        `Call memory_save to preserve important context. Do NOT use project_path.`
      )
      tracker.lastSavedTokens = usage.tokens.total
    } else if (tokenGrowth >= AUTO_SAVE_INTERVAL) {
      output.system.push(
        `[MEMORY PLUGIN] ${usage.tokens.total.toLocaleString()} tokens used this session. ` +
        `Call memory_save with a summary of what has been accomplished so far. Do NOT use project_path.`
      )
      tracker.lastSavedTokens = usage.tokens.total
    }
  }
}
