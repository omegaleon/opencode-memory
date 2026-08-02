import type { PluginInput } from "@opencode-ai/plugin"
import { openDb, listHistorySessions, getSessionMessages } from "./db.js"
import { buildTranscript } from "./transcript.js"
import { distillTranscript } from "./distill.js"
import { readState, writeState } from "./state.js"
import { maybeCommit } from "./git.js"
import { getWikiDir } from "./wiki.js"

/** Transcripts below this contain nothing distillable — marked done, no LLM call */
const MIN_TRANSCRIPT_CHARS = 500
/** Recent per-session results kept for status display */
const RECENT_RESULTS_MAX = 10

interface RunnerState {
  running: boolean
  cancelRequested: boolean
  startedAt: number
  finishedAt: number
  processed: number
  pagesWritten: number
  skipped: number
  failed: number
  planned: number
  current: string
  recent: string[]
  endReason: string
}

/**
 * Detached bootstrap runner. The tool call returns immediately; the batch
 * runs fire-and-forget in the plugin process (same pattern as the janitor),
 * checkpointing per session into {wiki}/.memory-state.json. The session
 * stays free for questions; progress is polled via status().
 *
 * Process-wide singleton: one run at a time; the janitor pauses while a
 * run is active (both drive distillation children — no point competing).
 */
const runner: RunnerState = {
  running: false,
  cancelRequested: false,
  startedAt: 0,
  finishedAt: 0,
  processed: 0,
  pagesWritten: 0,
  skipped: 0,
  failed: 0,
  planned: 0,
  current: "",
  recent: [],
  endReason: "",
}

export function isBootstrapRunning(): boolean {
  return runner.running
}

/**
 * Start a detached run. Returns a user-facing message; never throws.
 * excludeSessionID is the live session that invoked the tool.
 */
export async function startBootstrap(
  client: PluginInput["client"],
  excludeSessionID: string,
  opts: { limit?: number; minMessages?: number }
): Promise<string> {
  if (runner.running) {
    return "A bootstrap run is ALREADY ACTIVE — check it with action=\"status\", stop it with action=\"cancel\"."
  }

  const db = await openDb()
  if (!db) {
    return (
      "Bootstrap unavailable: could not open OpenCode's session database " +
      "(~/.local/share/opencode/opencode.db). This machine may store sessions " +
      "differently or the runtime lacks bun:sqlite."
    )
  }

  const state = readState()
  const done = new Set([...state.bootstrapDone, ...state.pluginSessions, excludeSessionID])
  const all = listHistorySessions(db)
  const pending = all.filter((s) => !done.has(s.id))

  if (pending.length === 0) {
    try {
      db.close()
    } catch {}
    return `Bootstrap complete. ${all.length} session(s) total, all processed. Wiki: ${getWikiDir()}`
  }

  const batch = opts.limit != null ? pending.slice(0, opts.limit) : pending
  const minMessages = opts.minMessages ?? 2

  // Reset counters and mark running BEFORE detaching
  runner.running = true
  runner.cancelRequested = false
  runner.startedAt = Date.now()
  runner.finishedAt = 0
  runner.processed = 0
  runner.pagesWritten = 0
  runner.skipped = 0
  runner.failed = 0
  runner.planned = batch.length
  runner.current = ""
  runner.recent = []
  runner.endReason = ""

  // Fire-and-forget: intentionally not awaited
  void runLoop(client, db, batch, minMessages, excludeSessionID)

  return (
    `Bootstrap started in the background — ${batch.length} session(s) queued ` +
    `(${pending.length} pending total${opts.limit != null ? `, limited to ${batch.length}` : ""}). ` +
    `This session stays free. Check progress anytime with memory_bootstrap action="status"; ` +
    `stop with action="cancel". Progress also visible in ${getWikiDir()}/.memory-state.json.`
  )
}

/** Instant progress report — safe to call any time, running or not */
export async function bootstrapStatus(): Promise<string> {
  const state = readState()
  const doneCount = state.bootstrapDone.length

  let totalKnown = ""
  const db = await openDb()
  if (db) {
    try {
      const total = listHistorySessions(db).length
      totalKnown = ` Overall: ${doneCount}/${total} historical sessions processed.`
    } catch {}
    try {
      db.close()
    } catch {}
  }

  if (!runner.running) {
    const last =
      runner.finishedAt > 0
        ? ` Last run: ${runner.processed} processed, ${runner.pagesWritten} page write(s), ` +
          `${runner.skipped} skipped, ${runner.failed} failed — ${runner.endReason}.`
        : ""
    return `No bootstrap run active.${last}${totalKnown}`
  }

  const elapsed = Math.round((Date.now() - runner.startedAt) / 1000)
  const lines = [
    `Bootstrap RUNNING (${elapsed}s elapsed) — ${runner.processed}/${runner.planned} this run: ` +
      `${runner.pagesWritten} page write(s), ${runner.skipped} skipped, ${runner.failed} failed.`,
    runner.current ? `Currently distilling: ${runner.current}` : "",
    runner.cancelRequested ? "CANCEL REQUESTED — stopping after the current session." : "",
    runner.recent.length > 0 ? "Recent:" : "",
    ...runner.recent,
    totalKnown.trim(),
  ]
  return lines.filter(Boolean).join("\n")
}

/** Request a stop; honored between sessions, current distillation finishes */
export function cancelBootstrap(): string {
  if (!runner.running) {
    return "No bootstrap run active — nothing to cancel."
  }
  runner.cancelRequested = true
  return (
    "Cancel requested. The run will stop after the session currently being " +
    "distilled finishes (its progress is checkpointed). Restart later with " +
    "action=\"start\" — it resumes where it left off."
  )
}

async function runLoop(
  client: PluginInput["client"],
  db: any,
  batch: Array<{ id: string; directory: string; title: string; messageCount: number }>,
  minMessages: number,
  parentSessionID: string
): Promise<void> {
  try {
    for (const session of batch) {
      if (runner.cancelRequested) {
        runner.endReason = "cancelled"
        return
      }

      const label = `${session.id.slice(0, 12)} (${session.title || "untitled"})`
      runner.current = label

      try {
        if (session.messageCount < minMessages) {
          markDone(session.id)
          runner.processed++
          runner.skipped++
          pushRecent(`- ${label}: skipped (only ${session.messageCount} messages)`)
          continue
        }

        const messages = getSessionMessages(db, session.id)
        const transcript = buildTranscript(messages)
        if (transcript.text.length < MIN_TRANSCRIPT_CHARS) {
          markDone(session.id)
          runner.processed++
          runner.skipped++
          pushRecent(`- ${label}: skipped (trivial transcript)`)
          continue
        }

        const report = await distillTranscript(client, {
          transcript: transcript.text,
          directory: session.directory,
          parentSessionID,
          sourceSessionID: session.id,
          onPluginSession: (id) => {
            const s = readState()
            s.pluginSessions.push(id)
            writeState(s)
          },
        })

        if (!report) {
          // Timeout/error — not marked done, retried on a future run
          runner.processed++
          runner.failed++
          pushRecent(`- ${label}: FAILED (will retry on next run)`)
          continue
        }

        markDone(session.id)
        runner.processed++
        runner.pagesWritten += report.written.length
        const detail = [
          report.written.length > 0 ? `wrote ${report.written.join(", ")}` : "nothing durable",
          ...report.skipped.map((s) => `rejected ${s}`),
          ...report.redacted.map((r) => `REDACTED ${r}`),
        ].join("; ")
        pushRecent(`- ${label}: ${detail}`)

        if (report.written.length > 0) {
          maybeCommit(`memory: bootstrap ${session.id.slice(0, 12)} (${report.written.length} page write(s))`)
        }
      } catch {
        runner.processed++
        runner.failed++
        pushRecent(`- ${label}: FAILED (unexpected error)`)
      }
    }
    runner.endReason = "completed"
  } catch {
    runner.endReason = "aborted (unexpected error)"
  } finally {
    runner.running = false
    runner.current = ""
    runner.finishedAt = Date.now()
    try {
      db.close()
    } catch {}
  }
}

function markDone(sessionID: string): void {
  const s = readState()
  if (!s.bootstrapDone.includes(sessionID)) {
    s.bootstrapDone.push(sessionID)
    writeState(s)
  }
}

function pushRecent(line: string): void {
  runner.recent.push(line)
  if (runner.recent.length > RECENT_RESULTS_MAX) {
    runner.recent.shift()
  }
}
