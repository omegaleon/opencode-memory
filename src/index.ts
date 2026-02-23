import type { Plugin } from "@opencode-ai/plugin"
import { createContextUsageTool } from "./tools/context-usage.js"
import { createMemoryRecallTool } from "./tools/memory-recall.js"
import { createMemorySaveTool } from "./tools/memory-save.js"
import { createCompactionHook } from "./hooks/compaction.js"
import { createEventHook, type SessionTracker } from "./hooks/events.js"
import { createSystemHook } from "./hooks/system.js"

export const MemoryPlugin: Plugin = async ({ client, directory }) => {
  // Shared state for tracking the current session and auto-save thresholds
  const tracker: SessionTracker = {
    currentSessionID: null,
    lastActivity: Date.now(),
    lastSavedTokens: 0,
    saving: false,
  }

  return {
    // Register custom tools
    tool: {
      context_usage: createContextUsageTool(client),
      memory_recall: createMemoryRecallTool(),
      memory_save: createMemorySaveTool(client, directory),
    },

    // Event tracking + auto-save every ~10K tokens
    event: createEventHook(client, directory, tracker),

    // Auto-save on compaction (extracts data directly, then asks LLM to enrich)
    "experimental.session.compacting": createCompactionHook(client, directory),

    // Context % warnings in system prompt
    "experimental.chat.system.transform": createSystemHook(client, tracker),
  }
}

export default MemoryPlugin
