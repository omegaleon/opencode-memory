import { tool } from "@opencode-ai/plugin/tool"
import type { PluginInput } from "@opencode-ai/plugin"
import { getContextUsage } from "../lib/context.js"
import { writeIndexEntry, writeSessionFile } from "../lib/storage.js"

export function createMemorySaveTool(
  client: PluginInput["client"],
  directory: string
) {
  return tool({
    description:
      "Save current session context to persistent memory. " +
      "Writes a summary to the global memory index and full detail to a local session file. " +
      "Call this to preserve important context before compaction or at the end of a session. " +
      "Can be called multiple times — subsequent calls update the existing entry for this session.",
    args: {
      summary: tool.schema
        .string()
        .describe(
          "1-3 sentence summary of what was accomplished in this session."
        ),
      key_topics: tool.schema
        .string()
        .describe(
          "Comma-separated list of key topics, technologies, and concepts discussed."
        ),
      decisions: tool.schema
        .string()
        .describe(
          "Key decisions made during this session and their rationale."
        ),
      code_changes: tool.schema
        .string()
        .optional()
        .describe(
          "Summary of files created, modified, or deleted."
        ),
      important_context: tool.schema
        .string()
        .optional()
        .describe(
          "Technical details, discoveries, or context that would be valuable in future sessions."
        ),
      unfinished: tool.schema
        .string()
        .optional()
        .describe(
          "Any unfinished work or next steps for future sessions."
        ),
    },
    async execute(args, context) {
      const date = new Date().toISOString().slice(0, 10)
      const shortID = context.sessionID.length > 8
        ? context.sessionID.slice(0, 8)
        : context.sessionID

      // Get current context usage for the session file
      const usage = await getContextUsage(client, context.sessionID)

      // Write the local session file
      const sessionFilePath = writeSessionFile(directory, {
        sessionID: shortID,
        date,
        project: directory,
        model: usage?.model.id,
        tokensUsed: usage?.tokens.total,
        contextPercent: usage?.percentage,
        summary: args.summary,
        keyTopics: args.key_topics,
        decisions: args.decisions,
        codeChanges: args.code_changes,
        importantContext: args.important_context,
        unfinished: args.unfinished,
      })

      // Write/update the global index entry
      writeIndexEntry({
        date,
        sessionID: shortID,
        project: directory,
        summary: args.summary,
        keyTopics: args.key_topics,
        decisions: args.decisions,
        unfinished: args.unfinished,
        sessionFilePath,
      })

      const usageInfo = usage
        ? ` Context: ${usage.tokens.total.toLocaleString()} tokens (${usage.percentage}%).`
        : ""

      return [
        `Session saved to memory.${usageInfo}`,
        `Global index: ~/.config/opencode/memory/MEMORY.md`,
        `Session file: ${sessionFilePath}`,
      ].join("\n")
    },
  })
}
