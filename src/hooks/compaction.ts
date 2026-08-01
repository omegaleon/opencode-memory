import type { Hooks } from "@opencode-ai/plugin"

/**
 * Last-ditch capture before compaction wipes context. The janitor is the
 * primary capture path (out-of-band, on idle); this fires only in the rare
 * case compaction actually happens, and injects ONCE — no nagging.
 */
export function createCompactionHook(): Hooks["experimental.session.compacting"] {
  return async (_input, output) => {
    output.context.push(
      "MEMORY: This session is being compacted. If it produced durable, reusable " +
      "knowledge not yet in the wiki (root causes, access patterns, deployment " +
      "details, key decisions), call memory_write now — one Topic/Investigation/" +
      "Project page with distilled content. If nothing durable was learned, do nothing."
    )
  }
}
