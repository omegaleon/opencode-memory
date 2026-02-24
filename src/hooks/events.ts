import type { Hooks, PluginInput } from "@opencode-ai/plugin"

const AUTO_SAVE_INTERVAL = 10_000 // Prompt LLM to save every 10K token increase

export interface SessionTracker {
  currentSessionID: string | null
  lastActivity: number
  lastSavedTokens: number
  promptedToSave: boolean
}

/**
 * Track session ID from message events so the system hook
 * can inject save reminders at token thresholds.
 */
export function createEventHook(
  client: PluginInput["client"],
  directory: string,
  tracker: SessionTracker
): Hooks["event"] {
  return async ({ event }) => {
    if (event.type === "message.updated") {
      const msg = (event as any).properties
      const sessionID = msg?.info?.sessionID ?? msg?.sessionID
      if (sessionID) {
        tracker.currentSessionID = sessionID
        tracker.lastActivity = Date.now()
      }
    }
  }
}
