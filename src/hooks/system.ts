import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { getContextUsage } from "../lib/context.js"

export interface SystemHookState {
  currentSessionID: string | null
}

/**
 * Inject context usage warnings into the system prompt when usage is high.
 * This gives the LLM passive awareness of how full the context window is.
 */
export function createSystemHook(
  client: PluginInput["client"],
  state: SystemHookState
): Hooks["experimental.chat.system.transform"] {
  return async (input, output) => {
    // We need a session ID to check usage. Try to get it from the input
    // or from the tracked state.
    const sessionID = (input as any).sessionID ?? state.currentSessionID
    if (!sessionID) return

    const usage = await getContextUsage(client, sessionID)
    if (!usage) return

    if (usage.percentage >= 80) {
      output.system.push(
        `[MEMORY PLUGIN] Context usage: ${usage.percentage}% (${usage.tokens.total.toLocaleString()} / ${usage.model.contextLimit.toLocaleString()} tokens). ` +
        `Compaction is imminent. Use memory_save NOW to preserve important session context before it is lost.`
      )
    } else if (usage.percentage >= 60) {
      output.system.push(
        `[MEMORY PLUGIN] Context usage: ${usage.percentage}% (${usage.tokens.total.toLocaleString()} / ${usage.model.contextLimit.toLocaleString()} tokens). ` +
        `Consider using memory_save to preserve important context. Use memory_recall to search past sessions.`
      )
    }
  }
}
