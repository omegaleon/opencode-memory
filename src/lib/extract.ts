import type { PluginInput } from "@opencode-ai/plugin"
import type { SessionDetail } from "./storage.js"
import { getContextUsage } from "./context.js"

interface MessageWithParts {
  info: {
    role: string
    id: string
    sessionID: string
    time: { created: number; completed?: number }
    [key: string]: unknown
  }
  parts: Array<{
    type: string
    text?: string
    tool?: string
    state?: {
      status: string
      input?: Record<string, unknown>
      output?: string
      title?: string
      error?: string
    }
    [key: string]: unknown
  }>
}

/**
 * Auto-extract structured memory data from session messages.
 * No LLM call needed — parses messages directly.
 */
export async function extractSessionData(
  client: PluginInput["client"],
  sessionID: string,
  directory: string
): Promise<SessionDetail | null> {
  try {
    const { data: messages } = await client.session.messages({
      path: { id: sessionID },
    })

    if (!messages || messages.length === 0) return null

    const msgs = messages as MessageWithParts[]

    // Extract user messages (topics/questions)
    const userTexts: string[] = []
    for (const msg of msgs) {
      if (msg.info.role !== "user") continue
      for (const part of msg.parts) {
        if (part.type === "text" && part.text) {
          // Take first 200 chars of each user message as a topic indicator
          const text = part.text.trim()
          if (text.length > 0) {
            userTexts.push(text.length > 200 ? text.slice(0, 200) + "..." : text)
          }
        }
      }
    }

    // Extract tool calls (actions taken)
    const toolCalls: Array<{ tool: string; title?: string; status: string }> = []
    const filesModified = new Set<string>()

    for (const msg of msgs) {
      if (msg.info.role !== "assistant") continue
      for (const part of msg.parts) {
        if (part.type !== "tool" || !part.tool) continue

        const state = part.state
        if (!state) continue

        toolCalls.push({
          tool: part.tool,
          title: state.title,
          status: state.status,
        })

        // Track file modifications from write/edit tool calls
        if (
          (part.tool === "write" || part.tool === "edit") &&
          state.input
        ) {
          const filePath =
            (state.input as any).filePath ??
            (state.input as any).file_path ??
            (state.input as any).path
          if (typeof filePath === "string") {
            filesModified.add(filePath)
          }
        }

        // Track bash commands that created files
        if (part.tool === "bash" && state.input) {
          const cmd = (state.input as any).command ?? ""
          if (typeof cmd === "string") {
            const mkdirMatch = cmd.match(/mkdir\s+(?:-p\s+)?(\S+)/)
            if (mkdirMatch) filesModified.add(mkdirMatch[1]!)
          }
        }
      }
    }

    // Build summary from user messages
    const topicLines = userTexts.slice(0, 10).map((t, i) => `${i + 1}. ${t}`)
    const summary = topicLines.length > 0
      ? `User topics:\n${topicLines.join("\n")}`
      : "No user messages extracted."

    // Build key topics from tool names and user message keywords
    const toolNames = [...new Set(toolCalls.map((t) => t.tool))]
    const keyTopics = toolNames.join(", ") || "general discussion"

    // Build decisions from tool actions
    const completedTools = toolCalls.filter((t) => t.status === "completed")
    const toolSummary = completedTools
      .slice(0, 20)
      .map((t) => `- ${t.tool}${t.title ? `: ${t.title}` : ""}`)
      .join("\n")
    const decisions = toolSummary || "No completed tool actions recorded."

    // Build code changes
    const codeChanges = filesModified.size > 0
      ? [...filesModified].map((f) => `- ${f}`).join("\n")
      : undefined

    // Get context usage
    const usage = await getContextUsage(client, sessionID)

    const shortID = sessionID.length > 8 ? sessionID.slice(0, 8) : sessionID
    const date = new Date().toISOString().slice(0, 10)

    return {
      sessionID: shortID,
      date,
      project: directory,
      model: usage?.model.id,
      tokensUsed: usage?.tokens.total,
      contextPercent: usage?.percentage,
      summary,
      keyTopics,
      decisions,
      codeChanges,
      importantContext: `Total messages: ${msgs.length}. Tool calls: ${toolCalls.length}. Files modified: ${filesModified.size}.`,
      unfinished: undefined,
    }
  } catch {
    return null
  }
}
