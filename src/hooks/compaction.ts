import type { Hooks } from "@opencode-ai/plugin"

/**
 * Hook into session compaction to instruct the LLM to save memory
 * before context is wiped. The LLM writes the summary — not auto-extract.
 */
export function createCompactionHook(): Hooks["experimental.session.compacting"] {
  return async (input, output) => {
    output.context.push(
      "MEMORY PLUGIN: This session is about to be compacted and context will be lost. " +
      "You MUST call memory_save NOW before compaction completes. " +
      "Write a high-quality summary covering: what was built or changed, key technical decisions, " +
      "important discoveries, and any unfinished work. " +
      "Do NOT use project_path — omit it entirely so the session file is written correctly. " +
      "This is your only chance to preserve this session's context."
    )
  }
}
