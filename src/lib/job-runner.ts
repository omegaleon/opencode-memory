/**
 * Shared background job runner for long, multi-item memory work
 * (bootstrap sweeps, investigation consolidation).
 *
 * Why detached: each item is an LLM round-trip, so a batch can run for tens of
 * minutes. Running inline would occupy the caller's session — the tool call
 * would not return, and user messages would queue behind it. Instead the tool
 * returns immediately and the loop runs fire-and-forget in the plugin process,
 * checkpointing per item so a crash or restart loses at most one item.
 *
 * Only ONE job runs at a time process-wide: both job kinds drive distillation
 * children and write the same wiki pages, so concurrent runs would race merges.
 */

export interface JobItem {
  id: string
  label: string
}

export interface JobItemResult {
  outcome: "written" | "skipped" | "failed"
  detail: string
  /** Pages written for this item (drives the total counter) */
  pages?: number
}

export type JobWorker = (item: JobItem) => Promise<JobItemResult>

/** Recent per-item results retained for status display */
const RECENT_MAX = 10

interface JobState {
  running: boolean
  kind: string
  cancelRequested: boolean
  startedAt: number
  finishedAt: number
  processed: number
  pages: number
  skipped: number
  failed: number
  planned: number
  current: string
  recent: string[]
  endReason: string
}

const job: JobState = {
  running: false,
  kind: "",
  cancelRequested: false,
  startedAt: 0,
  finishedAt: 0,
  processed: 0,
  pages: 0,
  skipped: 0,
  failed: 0,
  planned: 0,
  current: "",
  recent: [],
  endReason: "",
}

/** True while any background memory job is active (janitor pauses on this) */
export function isJobRunning(): boolean {
  return job.running
}

/** Kind of the active job, or "" when idle */
export function activeJobKind(): string {
  return job.running ? job.kind : ""
}

/**
 * Start a detached job. Returns false if one is already running.
 * `onFinish` always runs (success, cancel, or error) — use it for cleanup.
 */
export function startJob(
  kind: string,
  items: JobItem[],
  worker: JobWorker,
  onFinish?: () => void
): boolean {
  if (job.running) return false

  job.running = true
  job.kind = kind
  job.cancelRequested = false
  job.startedAt = Date.now()
  job.finishedAt = 0
  job.processed = 0
  job.pages = 0
  job.skipped = 0
  job.failed = 0
  job.planned = items.length
  job.current = ""
  job.recent = []
  job.endReason = ""

  // Intentionally not awaited — this is the whole point of the runner
  void runLoop(items, worker, onFinish)
  return true
}

async function runLoop(items: JobItem[], worker: JobWorker, onFinish?: () => void): Promise<void> {
  try {
    for (const item of items) {
      if (job.cancelRequested) {
        job.endReason = "cancelled"
        return
      }
      job.current = item.label
      try {
        const result = await worker(item)
        job.processed++
        job.pages += result.pages ?? 0
        if (result.outcome === "skipped") job.skipped++
        if (result.outcome === "failed") job.failed++
        pushRecent(`- ${item.label}: ${result.detail}`)
      } catch {
        job.processed++
        job.failed++
        pushRecent(`- ${item.label}: FAILED (unexpected error)`)
      }
    }
    job.endReason = "completed"
  } catch {
    job.endReason = "aborted (unexpected error)"
  } finally {
    job.running = false
    job.current = ""
    job.finishedAt = Date.now()
    try {
      onFinish?.()
    } catch {}
  }
}

/** Request a stop; honored between items so the current one finishes cleanly */
export function cancelJob(): string {
  if (!job.running) return "No background memory job is active — nothing to cancel."
  job.cancelRequested = true
  return (
    `Cancel requested for the ${job.kind} run. It will stop after the item currently ` +
    `being processed finishes (progress is checkpointed). Starting again later resumes ` +
    `where it left off.`
  )
}

/**
 * Progress report for the active job, or a summary of the last one.
 * `extra` lets callers append job-specific totals (e.g. overall done/total).
 */
export function jobStatus(extra?: string): string {
  if (!job.running) {
    const last =
      job.finishedAt > 0
        ? `Last ${job.kind} run: ${job.processed} processed, ${job.pages} page write(s), ` +
          `${job.skipped} skipped, ${job.failed} failed — ${job.endReason}.`
        : "No background memory job has run in this process."
    return [last, extra].filter(Boolean).join("\n")
  }

  const elapsed = Math.round((Date.now() - job.startedAt) / 1000)
  return [
    `${job.kind} RUNNING (${elapsed}s elapsed) — ${job.processed}/${job.planned}: ` +
      `${job.pages} page write(s), ${job.skipped} skipped, ${job.failed} failed.`,
    job.current ? `Currently processing: ${job.current}` : "",
    job.cancelRequested ? "CANCEL REQUESTED — stopping after the current item." : "",
    job.recent.length > 0 ? "Recent:" : "",
    ...job.recent,
    extra ?? "",
  ]
    .filter(Boolean)
    .join("\n")
}

function pushRecent(line: string): void {
  job.recent.push(line)
  if (job.recent.length > RECENT_MAX) job.recent.shift()
}
