import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { getContextUsage } from "../lib/context.js"
import { buildTranscript } from "../lib/transcript.js"
import { distillTranscript } from "../lib/distill.js"
import { readState, writeState } from "../lib/state.js"
import { maybeCommit } from "../lib/git.js"

/** Minimum time between harvests of the same session */
const HARVEST_MIN_INTERVAL_MS = 30 * 60_000
/** Minimum token growth since last harvest before another one runs */
const HARVEST_MIN_TOKEN_GROWTH = 5_000
/** Transcripts shorter than this contain nothing worth distilling */
const MIN_TRANSCRIPT_CHARS = 500

/**
 * Background knowledge harvester. Listens for session.idle and distills the
 * transcript delta (since the last harvest cursor) into wiki pages using a
 * child session — the user's live context is never touched and never grows.
 *
 * This replaces v1's in-session save nagging entirely: capture happens at
 * natural pauses, out-of-band, debounced by time AND token growth so that
 * however often session.idle fires, harvesting stays rare and cheap.
 */
export function createJanitorHook(client: PluginInput["client"], directory: string): Hooks["event"] {
  // Sessions currently being harvested — prevents overlapping runs
  const inFlight = new Set<string>()
  // Child sessions created by distillation this process — never harvest these
  const ownSessions = new Set<string>()

  return async ({ event }) => {
    if (event.type !== "session.idle") return
    const sessionID = (event as any).properties?.sessionID
    if (typeof sessionID !== "string" || inFlight.has(sessionID) || ownSessions.has(sessionID)) return

    inFlight.add(sessionID)
    try {
      const state = readState()
      if (state.pluginSessions.includes(sessionID)) return

      // Skip sub-sessions (Task subagents, our own distillation children)
      try {
        const { data: session } = await client.session.get({ path: { id: sessionID } })
        if (!session || (session as any).parentID) return
      } catch {
        return
      }

      // Debounce: time AND token growth
      const cursor = state.cursors[sessionID] ?? { lastTokens: 0, lastHarvest: 0 }
      if (Date.now() - cursor.lastHarvest < HARVEST_MIN_INTERVAL_MS) return

      const usage = await getContextUsage(client, sessionID)
      if (!usage) return
      if (usage.tokens.total - cursor.lastTokens < HARVEST_MIN_TOKEN_GROWTH) return

      // Build the transcript delta since the last harvest
      const { data: messages } = await client.session.messages({ path: { id: sessionID } })
      if (!messages) return
      const transcript = buildTranscript(messages as any, cursor.lastMessageID)
      if (transcript.text.length < MIN_TRANSCRIPT_CHARS) return

      const report = await distillTranscript(client, {
        transcript: transcript.text,
        directory,
        parentSessionID: sessionID,
        onPluginSession: (id) => {
          ownSessions.add(id)
          const s = readState()
          s.pluginSessions.push(id)
          writeState(s)
        },
      })

      // Advance the cursor even when nothing was written — the delta was seen
      if (report) {
        const s = readState()
        s.cursors[sessionID] = {
          lastMessageID: transcript.lastMessageID ?? cursor.lastMessageID,
          lastTokens: usage.tokens.total,
          lastHarvest: Date.now(),
        }
        writeState(s)

        if (report.written.length > 0) {
          maybeCommit(`memory: janitor harvest (${report.written.join(", ")})`)
        }
      }
    } catch {
      // Never block the host application
    } finally {
      inFlight.delete(sessionID)
    }
  }
}
