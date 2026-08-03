import type { PluginInput } from "@opencode-ai/plugin"
import { openDb, listHistorySessions, getSessionMessages } from "./db.js"
import { buildTranscript } from "./transcript.js"
import { distillTranscript } from "./distill.js"
import { readState, writeState } from "./state.js"
import { maybeCommit } from "./git.js"
import { getWikiDir } from "./wiki.js"
import { startJob, jobStatus, type JobItem, type JobItemResult } from "./job-runner.js"

/** Transcripts below this contain nothing distillable — marked done, no LLM call */
const MIN_TRANSCRIPT_CHARS = 500

/**
 * Start a detached bootstrap run over this machine's session history.
 * Returns a user-facing message; never throws.
 */
export async function startBootstrap(
  client: PluginInput["client"],
  excludeSessionID: string,
  opts: { limit?: number; minMessages?: number }
): Promise<string> {
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
    closeQuietly(db)
    return `Bootstrap complete. ${all.length} session(s) total, all processed. Wiki: ${getWikiDir()}`
  }

  const batch = opts.limit != null ? pending.slice(0, opts.limit) : pending
  const minMessages = opts.minMessages ?? 2
  const byID = new Map(batch.map((s) => [s.id, s]))

  const items: JobItem[] = batch.map((s) => ({
    id: s.id,
    label: `${s.id.slice(0, 12)} (${s.title || "untitled"})`,
  }))

  const worker = async (item: JobItem): Promise<JobItemResult> => {
    const session = byID.get(item.id)!

    if (session.messageCount < minMessages) {
      markBootstrapped(session.id)
      return { outcome: "skipped", detail: `skipped (only ${session.messageCount} messages)` }
    }

    const messages = getSessionMessages(db, session.id)
    const transcript = buildTranscript(messages)
    if (transcript.text.length < MIN_TRANSCRIPT_CHARS) {
      markBootstrapped(session.id)
      return { outcome: "skipped", detail: "skipped (trivial transcript)" }
    }

    const report = await distillTranscript(client, {
      transcript: transcript.text,
      directory: session.directory,
      parentSessionID: excludeSessionID,
      sourceSessionID: session.id,
      onPluginSession: recordPluginSession,
    })

    if (!report) {
      // Not marked done — retried on a future run
      return { outcome: "failed", detail: "FAILED (will retry on next run)" }
    }

    // Content was produced but every page was rejected: do NOT mark the
    // session done, or the knowledge is stranded forever. Report it as a
    // failure so it is visible and retried, never as "nothing durable".
    if (report.written.length === 0 && report.skipped.length > 0) {
      return {
        outcome: "failed",
        detail: `ALL PAGES REJECTED (will retry): ${report.skipped.join("; ")}`,
      }
    }

    markBootstrapped(session.id)
    if (report.written.length > 0) {
      maybeCommit(`memory: bootstrap ${session.id.slice(0, 12)} (${report.written.length} page write(s))`)
    }
    return {
      outcome: report.written.length > 0 ? "written" : "skipped",
      pages: report.written.length,
      detail: [
        report.written.length > 0 ? `wrote ${report.written.join(", ")}` : "nothing durable",
        ...report.skipped.map((s) => `REJECTED ${s}`),
        ...report.redacted.map((r) => `redacted ${r}`),
      ].join("; "),
    }
  }

  const started = startJob("bootstrap", items, worker, () => closeQuietly(db))
  if (!started) {
    closeQuietly(db)
    return (
      "A background memory job is ALREADY RUNNING. Check it with " +
      'memory_bootstrap action="status", or stop it with action="cancel".'
    )
  }

  return (
    `Bootstrap started in the background — ${batch.length} session(s) queued ` +
    `(${pending.length} pending total${opts.limit != null ? `, limited to ${batch.length}` : ""}). ` +
    `This session stays free. Check progress anytime with memory_bootstrap action="status"; ` +
    `stop with action="cancel".`
  )
}

/** Progress report including overall history coverage */
export async function bootstrapStatus(): Promise<string> {
  const state = readState()
  const doneCount = state.bootstrapDone.length

  let overall = ""
  const db = await openDb()
  if (db) {
    try {
      const total = listHistorySessions(db).length
      const pending = Math.max(0, total - doneCount)
      overall =
        `Overall: ${doneCount}/${total} historical sessions distilled` +
        (pending > 0 ? ` — ${pending} pending.` : " — up to date.")
    } catch {}
    closeQuietly(db)
  }

  return jobStatus(overall)
}

function markBootstrapped(sessionID: string): void {
  const s = readState()
  if (!s.bootstrapDone.includes(sessionID)) {
    s.bootstrapDone.push(sessionID)
    writeState(s)
  }
}

function recordPluginSession(id: string): void {
  const s = readState()
  s.pluginSessions.push(id)
  writeState(s)
}

function closeQuietly(db: any): void {
  try {
    db.close()
  } catch {}
}
