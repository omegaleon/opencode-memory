import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { extractSessionData } from "../lib/extract.js"
import { writeIndexEntry, writeSessionFile } from "../lib/storage.js"

/**
 * Hook into session compaction to:
 * 1. Auto-save session data to memory BEFORE compaction wipes context
 * 2. Inject instruction for the LLM to enrich the save with its own summary
 */
export function createCompactionHook(
  client: PluginInput["client"],
  directory: string
): Hooks["experimental.session.compacting"] {
  return async (input, output) => {
    // Step 1: Auto-extract and save immediately (no LLM needed)
    try {
      const data = await extractSessionData(client, input.sessionID, directory)
      if (data) {
        const sessionFilePath = writeSessionFile(directory, data)
        writeIndexEntry({
          date: data.date,
          sessionID: data.sessionID,
          project: directory,
          summary: data.summary,
          keyTopics: data.keyTopics,
          decisions: data.decisions,
          unfinished: data.unfinished,
          sessionFilePath,
        })
      }
    } catch {
      // Don't block compaction if memory save fails
    }

    // Step 2: Also ask the LLM to provide a richer summary
    output.context.push(
      "MEMORY PLUGIN: Session data has been auto-saved to persistent memory. " +
      "To improve the saved context, call memory_save with a human-readable summary, " +
      "key topics, decisions made, and any unfinished work. This will update the existing entry " +
      "with richer detail than the auto-extracted version."
    )
  }
}
