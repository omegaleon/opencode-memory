import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { getContextUsage } from "../lib/context.js"
import { extractSessionData } from "../lib/extract.js"
import { writeIndexEntry, writeSessionFile } from "../lib/storage.js"

const AUTO_SAVE_INTERVAL = 10_000 // Auto-save every 10K token increase

export interface SessionTracker {
  currentSessionID: string | null
  lastActivity: number
  lastSavedTokens: number
  saving: boolean
}

/**
 * Track session events and auto-save memory at token thresholds.
 * Saves automatically every ~10K tokens of context growth.
 */
export function createEventHook(
  client: PluginInput["client"],
  directory: string,
  tracker: SessionTracker
): Hooks["event"] {
  return async ({ event }) => {
    // Track session from message events
    if (event.type === "message.updated") {
      const msg = (event as any).properties
      if (msg?.sessionID) {
        tracker.currentSessionID = msg.sessionID
        tracker.lastActivity = Date.now()
      }

      // Check if we should auto-save based on token growth
      if (tracker.currentSessionID && !tracker.saving) {
        try {
          const usage = await getContextUsage(
            client,
            tracker.currentSessionID
          )
          if (!usage) return

          const tokenGrowth = usage.tokens.total - tracker.lastSavedTokens

          if (tokenGrowth >= AUTO_SAVE_INTERVAL) {
            tracker.saving = true
            try {
              const data = await extractSessionData(
                client,
                tracker.currentSessionID,
                directory
              )
              if (data) {
                const sessionFilePath = writeSessionFile(directory, data)
                writeIndexEntry({
                  date: data.date,
                  sessionID: data.sessionID,
                  project: directory,
                  summary: data.summary,
                  keyTopics: data.keyTopics,
                  decisions: data.decisions,
                  unfinished: data.unfinished,
                  sessionFilePath,
                })
                tracker.lastSavedTokens = usage.tokens.total
              }
            } finally {
              tracker.saving = false
            }
          }
        } catch {
          // Don't crash on auto-save failures
        }
      }
    }
  }
}
