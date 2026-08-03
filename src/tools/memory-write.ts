import { tool } from "@opencode-ai/plugin/tool"
import type { WikiPage, PageType } from "../lib/wiki.js"
import { readPage, writePage, pathFor, slugify, pageRevision, MAX_BODY_LINES } from "../lib/wiki.js"
import { maybeCommit } from "../lib/git.js"

export function createMemoryWriteTool() {
  return tool({
    description:
      "Write a page to the persistent wiki. Use when the user says to memorize/save " +
      "something, or when you have durable reusable knowledge worth keeping " +
      "(root causes, access patterns, deployment details, architecture decisions). " +
      "Page types: Topic (cross-project knowledge like 's3-troubleshooting'), " +
      "Investigation (one-off troubleshooting write-up), Project (per-codebase context, " +
      "requires code_path). " +
      "Writes REPLACE the page — if it already exists, first load it with memory_recall " +
      "and submit the full merged content. Never submit only the new fragment. " +
      `Body is capped at ${MAX_BODY_LINES} lines: distill, don't narrate.`,
    args: {
      type: tool.schema
        .enum(["Topic", "Investigation", "Project"])
        .describe("Page type — determines where the page lives in the wiki."),
      slug: tool.schema
        .string()
        .describe("Kebab-case page identifier, e.g. 's3-troubleshooting'. Reuse an existing slug to update that page."),
      title: tool.schema.string().describe("Short human-readable title."),
      description: tool.schema
        .string()
        .describe("ONE line (max 200 chars). Becomes this page's entry in the always-visible index — make it count."),
      content: tool.schema
        .string()
        .describe(
          "Full markdown body. For existing pages this REPLACES the body — merge old and new content before submitting."
        ),
      tags: tool.schema.string().optional().describe("Comma-separated lowercase tags."),
      code_path: tool.schema
        .string()
        .optional()
        .describe("Project pages only: absolute path of the code directory this page documents."),
      expect_revision: tool.schema
        .string()
        .optional()
        .describe(
          "Revision string from the memory_recall output you merged against. " +
            "Pass it whenever you are UPDATING an existing page: the write is rejected if the " +
            "page changed in the meantime (the background janitor writes pages too), so your " +
            "merge cannot silently discard someone else's content."
        ),
    },
    async execute(args) {
      const type = args.type as PageType
      const slug = slugify(args.slug)
      const relPath = pathFor(type, slug)
      const existing = readPage(relPath)

      // Compare-and-swap: reject a merge built on a stale read rather than
      // overwriting whatever changed underneath it.
      if (args.expect_revision && existing) {
        const current = pageRevision(relPath)
        if (current !== args.expect_revision) {
          return (
            `REJECTED (page changed since you read it — revision ${args.expect_revision} → ${current}).\n` +
            `Something else (most likely the background janitor) wrote this page while you were ` +
            `merging. Call memory_recall page="${relPath}" again, merge your changes into the ` +
            `CURRENT content, and retry with the new revision. Do not resubmit the old merge — ` +
            `it would discard their work.`
          )
        }
      }

      const page: WikiPage = {
        relPath,
        type,
        title: args.title,
        description: args.description,
        tags: (args.tags ?? "")
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
        timestamp: new Date().toISOString(),
        codePath: args.code_path ?? existing?.codePath,
        body: args.content,
      }

      let redacted: string[]
      try {
        redacted = writePage(page)
      } catch (err) {
        return `REJECTED: ${err instanceof Error ? err.message : err}`
      }

      maybeCommit(`memory: ${existing ? "update" : "add"} ${relPath}`)

      const action = existing ? "Updated" : "Created"
      return (
        `${action} ${relPath}\n` +
        `Its description now appears in the index injected into every session.` +
        (redacted.length > 0
          ? `\nCREDENTIALS REDACTED before writing (${redacted.join(", ")}) — the page stores ` +
            `placeholders instead. Record where a secret lives, never its value.`
          : "") +
        (existing ? "" : "\nNote: if a similar page already existed under a different slug, consider consolidating.")
      )
    },
  })
}
