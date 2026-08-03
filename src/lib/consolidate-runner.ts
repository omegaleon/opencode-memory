import type { PluginInput } from "@opencode-ai/plugin"
import { listPages, readPage } from "./wiki.js"
import { distillTranscript } from "./distill.js"
import { readState, writeState } from "./state.js"
import { maybeCommit } from "./git.js"
import { startJob, jobStatus, type JobItem, type JobItemResult } from "./job-runner.js"

/**
 * Prompt for promoting an investigation's reusable technique into standalone
 * Topic pages. The investigation itself is never modified — this is purely
 * additive harvesting.
 */
function buildSource(relPath: string, title: string, body: string): string {
  return (
    "The following is an existing Investigation page from the wiki.\n" +
    "Extract ONLY the durable, generalizable technique from it into Topic pages " +
    "(query/scoping techniques, tool flags, access patterns, gotchas, exact endpoints) " +
    "so the knowledge is usable in sessions unrelated to this incident.\n" +
    "Write the Topic content so it stands alone WITHOUT the incident narrative. " +
    `Do NOT emit an Investigation page — that page already exists at ${relPath} and must ` +
    "not be modified. Reference it from the Topic body as the source. If the investigation " +
    "contains no generalizable technique, output exactly: NOTHING TO SAVE\n\n" +
    `PAGE PATH: ${relPath}\n` +
    `TITLE: ${title}\n\n` +
    body
  )
}

/**
 * Start a detached consolidation sweep over investigations that have not yet
 * been mined for reusable technique. Returns a user-facing message.
 */
export function startConsolidate(
  client: PluginInput["client"],
  parentSessionID: string,
  directory: string,
  opts: { limit?: number; page?: string }
): string {
  const state = readState()
  const done = new Set(state.consolidated ?? [])

  const targets = opts.page
    ? [readPage(opts.page.trim())].filter((p): p is NonNullable<typeof p> => p != null && p.type === "Investigation")
    : listPages()
        .filter((p) => p.type === "Investigation" && !done.has(p.relPath))
        .sort((a, b) => b.relPath.localeCompare(a.relPath))
        .slice(0, opts.limit ?? undefined)

  if (targets.length === 0) {
    const total = listPages().filter((p) => p.type === "Investigation").length
    return opts.page
      ? `No investigation page found at: ${opts.page}`
      : `Nothing to consolidate. ${total} investigation(s) exist, all already processed.`
  }

  const byPath = new Map(targets.map((p) => [p.relPath, p]))
  const items: JobItem[] = targets.map((p) => ({ id: p.relPath, label: p.relPath }))

  const worker = async (item: JobItem): Promise<JobItemResult> => {
    const investigation = byPath.get(item.id)!

    const report = await distillTranscript(client, {
      transcript: buildSource(investigation.relPath, investigation.title, investigation.body),
      directory,
      parentSessionID,
      onPluginSession: (id) => {
        const s = readState()
        s.pluginSessions.push(id)
        writeState(s)
      },
    })

    if (!report) {
      return { outcome: "failed", detail: "FAILED (will retry on next run)" }
    }

    // Pages were produced but all rejected — do not mark consolidated, so the
    // investigation is retried rather than silently losing its technique.
    if (report.written.length === 0 && report.skipped.length > 0) {
      return {
        outcome: "failed",
        detail: `ALL PAGES REJECTED (will retry): ${report.skipped.join("; ")}`,
      }
    }

    // Guard: consolidation must never rewrite the investigation itself
    const topics = report.written.filter((p) => p !== investigation.relPath)

    const s = readState()
    s.consolidated = [...(s.consolidated ?? []), investigation.relPath]
    writeState(s)

    if (topics.length > 0) {
      maybeCommit(`memory: consolidate ${investigation.relPath} -> ${topics.join(", ")}`)
    }

    return {
      outcome: topics.length > 0 ? "written" : "skipped",
      pages: topics.length,
      detail:
        (topics.length > 0 ? `promoted to ${topics.join(", ")}` : "no generalizable technique") +
        (report.skipped.length > 0 ? ` [REJECTED: ${report.skipped.join("; ")}]` : "") +
        (report.redacted.length > 0 ? ` [redacted: ${report.redacted.join("; ")}]` : ""),
    }
  }

  const started = startJob("consolidate", items, worker)
  if (!started) {
    return (
      "A background memory job is ALREADY RUNNING. Check it with " +
      'memory_consolidate action="status", or stop it with action="cancel".'
    )
  }

  return (
    `Consolidation started in the background — ${targets.length} investigation(s) queued. ` +
    `This session stays free. Investigations are never modified or deleted; only topics are ` +
    `created or merged. Check progress with memory_consolidate action="status"; stop with ` +
    `action="cancel".`
  )
}

/** Progress report including overall consolidation coverage */
export function consolidateStatus(): string {
  const state = readState()
  const done = new Set(state.consolidated ?? [])
  const investigations = listPages().filter((p) => p.type === "Investigation")
  const pending = investigations.filter((p) => !done.has(p.relPath)).length

  const overall =
    `Overall: ${investigations.length - pending}/${investigations.length} investigations mined for technique` +
    (pending > 0 ? ` — ${pending} pending.` : " — up to date.")

  return jobStatus(overall)
}
