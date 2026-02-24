import { tool } from "@opencode-ai/plugin/tool"
import type { PluginInput } from "@opencode-ai/plugin"
import { getContextUsage } from "../lib/context.js"
import { writeIndexEntry, writeSessionFile } from "../lib/storage.js"
import { basename } from "node:path"

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
          "1-3 sentence summary of what was accomplished or what this project is."
        ),
      key_topics: tool.schema
        .string()
        .describe(
          "Comma-separated list of key topics, technologies, and concepts."
        ),
      decisions: tool.schema
        .string()
        .describe(
          "Key decisions, architecture notes, or technical details."
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
      project_path: tool.schema
        .string()
        .optional()
        .describe(
          "Override project path. When set, writes to global index ONLY (no local session file). " +
          "Used by memory_seed to save project profiles without polluting project directories."
        ),
    },
    async execute(args, context) {
      const date = new Date().toISOString().slice(0, 10)
      const projectDir = args.project_path ?? directory
      const isProjectSeed = !!args.project_path

      let sessionFilePath = ""
      let shortID: string

      if (isProjectSeed) {
        // Project seed: global index only, use project name as ID
        shortID = `seed-${basename(projectDir)}`
      } else {
        // Normal session save: write local file too
        shortID = context.sessionID.length > 8
          ? context.sessionID.slice(0, 8)
          : context.sessionID

        const usage = await getContextUsage(client, context.sessionID)

        sessionFilePath = writeSessionFile(projectDir, {
          sessionID: shortID,
          date,
          project: projectDir,
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
      }

      // Write/update the global index entry
      writeIndexEntry({
        date,
        sessionID: shortID,
        project: projectDir,
        summary: args.summary,
        keyTopics: args.key_topics,
        decisions: args.decisions,
        unfinished: args.unfinished,
        sessionFilePath,
      })

      if (isProjectSeed) {
        return [
          `Project profile saved to global memory index.`,
          `Project: ${projectDir}`,
          `Global index: ~/.config/opencode/memory/MEMORY.md`,
        ].join("\n")
      }

      const usage = await getContextUsage(client, context.sessionID)
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
