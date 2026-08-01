import { tool } from "@opencode-ai/plugin/tool"
import type { PluginInput } from "@opencode-ai/plugin"
import { openDb, listHistorySessions, getSessionMessages } from "../lib/db.js"
import { buildTranscript } from "../lib/transcript.js"
import { distillTranscript } from "../lib/distill.js"
import { readState, writeState } from "../lib/state.js"
import { maybeCommit } from "../lib/git.js"
import { getWikiDir } from "../lib/wiki.js"

/** Transcripts below this contain nothing distillable — marked done, no LLM call */
const MIN_TRANSCRIPT_CHARS = 500

/** Process-wide mutex: models sometimes emit parallel tool calls, and two
 * concurrent batches would distill the same sessions twice and race the
 * state file. Second caller bails out immediately instead. */
let bootstrapRunning = false

export function createMemoryBootstrapTool(client: PluginInput["client"]) {
  return tool({
    description:
      "Seed the wiki from this machine's ENTIRE OpenCode session history. " +
      "Processes historical sessions in batches: each one is distilled into wiki pages " +
      "(topics, investigations, project overviews) by a child session, out-of-band — " +
      "this session's context only receives short progress reports. " +
      "Resumable and idempotent: processed sessions are tracked, so call it repeatedly " +
      "until it reports 0 remaining. Run on a fresh install to bootstrap memory. " +
      "STRICTLY ONE CALL AT A TIME: never emit parallel memory_bootstrap calls — wait " +
      "for each call's report before making the next.",
    args: {
      limit: tool.schema
        .number()
        .optional()
        .describe("How many historical sessions to process this call. Default: 10."),
      min_messages: tool.schema
        .number()
        .optional()
        .describe("Skip sessions with fewer messages than this. Default: 2 (skips empty shells only)."),
    },
    async execute(args, context) {
      if (bootstrapRunning) {
        return (
          "A bootstrap batch is ALREADY RUNNING. Do not start another — wait for " +
          "the running call to return its report, then call memory_bootstrap again " +
          "if sessions remain."
        )
      }
      bootstrapRunning = true

      const db = await openDb()
      if (!db) {
        bootstrapRunning = false
        return (
          "Bootstrap unavailable: could not open OpenCode's session database " +
          "(~/.local/share/opencode/opencode.db). This machine may store sessions " +
          "differently or the runtime lacks bun:sqlite."
        )
      }

      try {
        const limit = args.limit ?? 10
        const minMessages = args.min_messages ?? 2

        const state = readState()
        const done = new Set([...state.bootstrapDone, ...state.pluginSessions, context.sessionID])
        const all = listHistorySessions(db)
        const pending = all.filter((s) => !done.has(s.id))

        if (pending.length === 0) {
          return `Bootstrap complete. ${all.length} session(s) total, all processed. Wiki: ${getWikiDir()}`
        }

        const batch = pending.slice(0, limit)
        const results: string[] = []
        let written = 0

        // Sequential on purpose: distillations share wiki state (later merges
        // must see earlier writes) and hammer one LLM provider — parallel
        // child sessions would race merges and trip rate limits.
        for (const session of batch) {
          const label = `${session.id.slice(0, 12)} (${session.title || "untitled"})`

          if (session.messageCount < minMessages) {
            markDone(session.id)
            results.push(`- ${label}: skipped (only ${session.messageCount} messages)`)
            continue
          }

          const messages = getSessionMessages(db, session.id)
          const transcript = buildTranscript(messages)
          if (transcript.text.length < MIN_TRANSCRIPT_CHARS) {
            markDone(session.id)
            results.push(`- ${label}: skipped (trivial transcript)`)
            continue
          }

          const report = await distillTranscript(client, {
            transcript: transcript.text,
            directory: session.directory,
            parentSessionID: context.sessionID,
            onPluginSession: (id) => {
              const s = readState()
              s.pluginSessions.push(id)
              writeState(s)
            },
          })

          if (!report) {
            // Distillation failed (timeout/error) — do NOT mark done, retry next call
            results.push(`- ${label}: FAILED (will retry on next call)`)
            continue
          }

          markDone(session.id)
          written += report.written.length
          const detail = [
            report.written.length > 0 ? `wrote ${report.written.join(", ")}` : "nothing durable",
            ...report.skipped.map((s) => `rejected ${s}`),
          ].join("; ")
          results.push(`- ${label}: ${detail}`)
        }

        if (written > 0) {
          maybeCommit(`memory: bootstrap batch (${written} page write(s))`)
        }

        const remaining = pending.length - batch.length
        return [
          `Bootstrap batch done — processed ${batch.length} session(s), ${written} page write(s).`,
          ...results,
          "",
          remaining > 0
            ? `${remaining} session(s) remaining. Call memory_bootstrap again to continue.`
            : `All ${all.length} historical sessions processed. Wiki: ${getWikiDir()}`,
        ].join("\n")
      } finally {
        bootstrapRunning = false
        try {
          db.close()
        } catch {}
      }

      function markDone(sessionID: string): void {
        const s = readState()
        if (!s.bootstrapDone.includes(sessionID)) {
          s.bootstrapDone.push(sessionID)
          writeState(s)
        }
      }
    },
  })
}
