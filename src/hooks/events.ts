import type { Hooks } from "@opencode-ai/plugin"

export interface SessionTracker {
  currentSessionID: string | null
  lastActivity: number
}

/**
 * Track session events to maintain awareness of the current session.
 * This is used by other components to know the active session ID.
 */
export function createEventHook(
  tracker: SessionTracker
): Hooks["event"] {
  return async ({ event }) => {
    // Track session changes
    if (event.type === "message.updated") {
      const msg = (event as any).properties
      if (msg?.sessionID) {
        tracker.currentSessionID = msg.sessionID
        tracker.lastActivity = Date.now()
      }
    }
  }
}
