/**
 * Build compact, readable transcripts from session messages.
 * Works on the SDK message shape ({ info, parts }) — the DB layer maps its
 * rows into the same shape.
 */

export interface TranscriptMessage {
  info: {
    id?: string
    role?: string
    [key: string]: unknown
  }
  parts: Array<{
    type?: string
    text?: string
    tool?: string
    state?: { title?: string; status?: string; [key: string]: unknown }
    [key: string]: unknown
  }>
}

export interface Transcript {
  text: string
  lastMessageID?: string
  messageCount: number
}

/** Per-message text cap — long dumps get truncated, the gist survives */
const MESSAGE_CHAR_CAP = 2_000
/** Total transcript cap per distillation chunk (~15K tokens) */
const TOTAL_CHAR_CAP = 60_000

/**
 * Render messages into a plain-text transcript. When sinceMessageID is set,
 * only messages after it are included (janitor cursor semantics). If the
 * result exceeds the total cap, the OLDEST content is dropped — recent
 * activity is what the janitor hasn't seen yet.
 */
export function buildTranscript(messages: TranscriptMessage[], sinceMessageID?: string): Transcript {
  let startIdx = 0
  if (sinceMessageID) {
    const idx = messages.findIndex((m) => m.info.id === sinceMessageID)
    if (idx >= 0) startIdx = idx + 1
  }

  const rendered: string[] = []
  let lastMessageID: string | undefined

  for (const msg of messages.slice(startIdx)) {
    const role = msg.info.role
    if (role !== "user" && role !== "assistant") continue
    if (typeof msg.info.id === "string") lastMessageID = msg.info.id

    const chunks: string[] = []
    for (const part of msg.parts ?? []) {
      if (part.type === "text" && part.text?.trim()) {
        chunks.push(truncate(part.text.trim(), MESSAGE_CHAR_CAP))
      } else if (part.type === "tool" && part.tool) {
        const title = part.state?.title ? `: ${truncate(part.state.title, 120)}` : ""
        chunks.push(`[tool ${part.tool}${title}]`)
      }
    }
    if (chunks.length === 0) continue
    rendered.push(`${role.toUpperCase()}:\n${chunks.join("\n")}`)
  }

  // Drop oldest content if over budget
  let text = rendered.join("\n\n")
  while (text.length > TOTAL_CHAR_CAP && rendered.length > 1) {
    rendered.shift()
    text = "(...earlier activity omitted...)\n\n" + rendered.join("\n\n")
  }

  return { text, lastMessageID, messageCount: rendered.length }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…(truncated)" : text
}
