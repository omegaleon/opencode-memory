import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs"
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
  /** Investigation page paths already swept by memory_consolidate */
  consolidated?: string[]
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
      consolidated: parsed.consolidated ?? [],
    }
  } catch {
    return emptyState()
  }
}

/**
 * Persist state atomically (temp file + rename). A partial write here is
 * catastrophic: corrupt JSON resets state, which re-bootstraps every session
 * and re-consolidates every investigation. rename() is atomic on POSIX, so a
 * crash leaves either the old file or the new one, never a truncated one.
 *
 * Also merges against the on-disk copy before writing, because callers do
 * read-modify-write and a concurrent job (janitor vs. bootstrap) could
 * otherwise drop the other's cursors or completion records.
 */
export function writeState(state: MemoryState): void {
  try {
    const dir = getWikiDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const onDisk = readState()
    const merged: MemoryState = {
      cursors: { ...onDisk.cursors, ...state.cursors },
      bootstrapDone: [...new Set([...onDisk.bootstrapDone, ...state.bootstrapDone])],
      pluginSessions: [...new Set([...onDisk.pluginSessions, ...state.pluginSessions])],
      consolidated: [...new Set([...(onDisk.consolidated ?? []), ...(state.consolidated ?? [])])],
    }

    // Keep pluginSessions bounded — only recent ones matter for idle filtering
    if (merged.pluginSessions.length > 200) {
      merged.pluginSessions = merged.pluginSessions.slice(-100)
    }

    const target = join(dir, STATE_FILE)
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf-8")
    try {
      renameSync(tmp, target)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {}
      throw err
    }
  } catch {
    // Don't block host application if state persistence fails
  }
}

function emptyState(): MemoryState {
  return { cursors: {}, bootstrapDone: [], pluginSessions: [], consolidated: [] }
}
