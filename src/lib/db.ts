import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { TranscriptMessage } from "./transcript.js"

export interface HistorySession {
  id: string
  directory: string
  title: string
  timeCreated: number
  messageCount: number
}

/**
 * Read-only access to OpenCode's own session store
 * (~/.local/share/opencode/opencode.db — session/message/part tables).
 * Used ONLY by bootstrap to enumerate historical sessions across all
 * projects; live sessions go through the SDK client instead.
 *
 * bun:sqlite ships with the Bun runtime OpenCode plugins execute in — no
 * dependency added. The schema is internal to OpenCode, so every access is
 * wrapped and failure degrades to "bootstrap unavailable", never a crash.
 */
export function getDbPath(): string {
  const dataHome = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "opencode.db")
}

export async function openDb(): Promise<any | null> {
  try {
    const dbPath = getDbPath()
    if (!existsSync(dbPath)) return null
    const { Database } = await import("bun:sqlite")
    return new Database(dbPath, { readonly: true })
  } catch {
    return null
  }
}

/** All top-level sessions (no subagent children), oldest first so that
 * newer knowledge wins merge conflicts during bootstrap. */
export function listHistorySessions(db: any): HistorySession[] {
  try {
    const rows = db
      .query(
        `SELECT s.id, s.directory, s.title, s.time_created,
                (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count
         FROM session s
         WHERE s.parent_id IS NULL
         ORDER BY s.time_created ASC`
      )
      .all()
    return rows.map((r: any) => ({
      id: r.id,
      directory: r.directory ?? "",
      title: r.title ?? "",
      timeCreated: r.time_created ?? 0,
      messageCount: r.message_count ?? 0,
    }))
  } catch {
    return []
  }
}

/** Load a session's messages+parts from the DB in the SDK message shape */
export function getSessionMessages(db: any, sessionID: string): TranscriptMessage[] {
  try {
    const messageRows = db
      .query(`SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC`)
      .all(sessionID)
    const partRows = db
      .query(`SELECT message_id, data FROM part WHERE session_id = ? ORDER BY id ASC`)
      .all(sessionID)

    const partsByMessage = new Map<string, any[]>()
    for (const row of partRows) {
      try {
        const part = JSON.parse(row.data)
        const list = partsByMessage.get(row.message_id) ?? []
        list.push(part)
        partsByMessage.set(row.message_id, list)
      } catch {}
    }

    const messages: TranscriptMessage[] = []
    for (const row of messageRows) {
      try {
        const info = JSON.parse(row.data)
        if (!info.id) info.id = row.id
        messages.push({ info, parts: partsByMessage.get(row.id) ?? [] })
      } catch {}
    }
    return messages
  } catch {
    return []
  }
}
