import type { Plugin } from "@opencode-ai/plugin"
import { createContextUsageTool } from "./tools/context-usage.js"
import { createMemoryRecallTool } from "./tools/memory-recall.js"
import { createMemoryWriteTool } from "./tools/memory-write.js"
import { createMemoryBootstrapTool } from "./tools/memory-bootstrap.js"
import { createMemoryConsolidateTool } from "./tools/memory-consolidate.js"
import { createMemoryStatusTool } from "./tools/memory-status.js"
import { createMemoryPruneTool } from "./tools/memory-prune.js"
import { createInjectHook } from "./hooks/inject.js"
import { createJanitorHook } from "./hooks/janitor.js"
import { createCompactionHook } from "./hooks/compaction.js"

/**
 * opencode-memory v2 — wiki-style persistent memory.
 *
 * Always-loaded surface: ONE system-prompt injection (derived TOC + recall
 * rule + matching project overview). Everything else is pulled on demand
 * (memory_recall) or produced out-of-band (janitor, bootstrap) so the live
 * session's context never pays for knowledge capture.
 *
 * Wiki location: ~/wiki (override with OPENCODE_WIKI_DIR). Plain markdown +
 * YAML frontmatter; Obsidian-compatible; git optional.
 */
export const MemoryPlugin: Plugin = async ({ client, directory }) => {
  return {
    tool: {
      context_usage: createContextUsageTool(client),
      memory_recall: createMemoryRecallTool(),
      memory_write: createMemoryWriteTool(),
      memory_bootstrap: createMemoryBootstrapTool(client),
      memory_consolidate: createMemoryConsolidateTool(client, directory),
      memory_status: createMemoryStatusTool(),
      memory_prune: createMemoryPruneTool(),
    },

    // Background janitor: harvest transcript deltas on session.idle
    event: createJanitorHook(client, directory),

    // TOC + recall rule + project overview injection
    "experimental.chat.system.transform": createInjectHook(directory),

    // Rare last-ditch capture if compaction ever fires
    "experimental.session.compacting": createCompactionHook(),
  }
}

export default MemoryPlugin
