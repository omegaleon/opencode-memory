import type { Hooks } from "@opencode-ai/plugin"

/**
 * Hook into session compaction to inject a "save to memory" instruction.
 * When compaction triggers, the LLM is asked to summarize the session.
 * We append instructions telling it to also save the summary to persistent memory.
 */
export function createCompactionHook(): Hooks["experimental.session.compacting"] {
  return async (_input, output) => {
    output.context.push(
      "IMPORTANT: Before this session is compacted, use the memory_save tool to preserve " +
      "the key context from this session. Include a summary of what was accomplished, " +
      "key topics discussed, decisions made, any code changes, and unfinished work. " +
      "This ensures context survives across sessions."
    )
  }
}
