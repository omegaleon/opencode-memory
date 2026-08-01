import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { getWikiDir } from "./wiki.js"

export interface SessionCursor {
  /** ID of the last message included in a harvest */
  lastMessageID?: string
  /** Total token count at last harvest (for the growth debounce) */
  lastTokens: number
  /** Epoch ms of last harvest */
  lastHarvest: number
}

export interface MemoryState {
  cursors: Record<string, SessionCursor>
  /** Session IDs already processed by bootstrap */
  bootstrapDone: string[]
  /** Child session IDs created by this plugin (never harvested) */
  pluginSessions: string[]
}

const STATE_FILE = ".memory-state.json"

/** Read plugin state from the wiki dir. Missing/corrupt state resets cleanly. */
export function readState(): MemoryState {
  try {
    const filePath = join(getWikiDir(), STATE_FILE)
    if (!existsSync(filePath)) return emptyState()
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"))
    return {
      cursors: parsed.cursors ?? {},
      bootstrapDone: parsed.bootstrapDone ?? [],
      pluginSessions: parsed.pluginSessions ?? [],
    }
  } catch {
    return emptyState()
  }
}

export function writeState(state: MemoryState): void {
  try {
    const dir = getWikiDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // Keep pluginSessions bounded — only recent ones matter for idle filtering
    if (state.pluginSessions.length > 200) {
      state.pluginSessions = state.pluginSessions.slice(-100)
    }
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, 2), "utf-8")
  } catch {
    // Don't block host application if state persistence fails
  }
}

function emptyState(): MemoryState {
  return { cursors: {}, bootstrapDone: [], pluginSessions: [] }
}
