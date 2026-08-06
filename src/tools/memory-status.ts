import { tool } from "@opencode-ai/plugin/tool"
import {
  listPages,
  deriveTOC,
  getWikiDir,
  tocTruncationCount,
  findDuplicates,
  findProjectPage,
  getLastUsedBudget,
  approxTokens,
  TOC_CONTEXT_SHARE,
} from "../lib/wiki.js"
import { readState } from "../lib/state.js"
import { openDb, listHistorySessions } from "../lib/db.js"
import { isJobRunning, activeJobKind } from "../lib/job-runner.js"
import { isGitRepo, getLastGitError } from "../lib/git.js"
import { getLastInjectedChars } from "../hooks/inject.js"

export function createMemoryStatusTool(directory: string) {
  return tool({
    description:
      "Report the health of the persistent memory wiki: page counts by type, most " +
      "recently written pages, when this session was last harvested by the background " +
      "janitor, how many historical sessions still need a bootstrap sweep, how many " +
      "investigations are pending consolidation, and whether the injected index is " +
      "over budget. Use this to answer 'was anything saved from my session?' or " +
      "'is the wiki up to date?'.",
    args: {},
    async execute(_args, context) {
      const pages = listPages()
      const state = readState()
      const wikiDir = getWikiDir()

      const byType = {
        Topic: pages.filter((p) => p.type === "Topic").length,
        Project: pages.filter((p) => p.type === "Project").length,
        Investigation: pages.filter((p) => p.type === "Investigation").length,
      }

      // Most recently written pages by frontmatter timestamp
      const recent = [...pages]
        .filter((p) => p.timestamp)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 5)

      const lines: string[] = [
        `Wiki: ${wikiDir}`,
        `Pages: ${pages.length} total — ${byType.Topic} topics, ${byType.Project} projects, ${byType.Investigation} investigations`,
      ]

      if (isJobRunning()) {
        lines.push(
          `Background job: ${activeJobKind()} RUNNING — call memory_${activeJobKind()} ` +
            `action="status" for detail.`
        )
      }

      // Was THIS session harvested?
      const cursor = state.cursors[context.sessionID]
      if (cursor?.lastHarvest) {
        const mins = Math.round((Date.now() - cursor.lastHarvest) / 60_000)
        lines.push(`This session: last harvested ${mins} min ago by the janitor.`)
      } else {
        lines.push(
          "This session: NOT yet harvested. The janitor harvests on idle " +
            "(>=30 min since last harvest and >=5K new tokens); anything it misses is " +
            "picked up by the next memory_bootstrap sweep."
        )
      }

      if (recent.length > 0) {
        lines.push("", "Most recently written pages:")
        for (const p of recent) {
          lines.push(`- ${p.relPath} (${p.timestamp.slice(0, 16).replace("T", " ")})`)
        }
      }

      // Pending bootstrap sweep — includes sessions created since the last run
      const db = await openDb()
      if (db) {
        try {
          const all = listHistorySessions(db)
          const done = new Set([...state.bootstrapDone, ...state.pluginSessions])
          const pending = all.filter((s) => !done.has(s.id)).length
          lines.push(
            "",
            pending > 0
              ? `Bootstrap sweep: ${pending} of ${all.length} sessions not yet distilled — run memory_bootstrap to catch up.`
              : `Bootstrap sweep: up to date (${all.length} sessions processed).`
          )
        } catch {
        } finally {
          try {
            db.close()
          } catch {}
        }
      }

      // Investigations awaiting technique extraction
      const consolidated = new Set(state.consolidated ?? [])
      const pendingConsolidation = pages.filter(
        (p) => p.type === "Investigation" && !consolidated.has(p.relPath)
      ).length
      if (pendingConsolidation > 0) {
        lines.push(
          `Consolidation: ${pendingConsolidation} investigation(s) not yet mined for reusable ` +
            `technique — run memory_consolidate to promote it into topics.`
        )
      }

      // Duplicate detection — reported, never auto-resolved
      const duplicates = findDuplicates(pages)
      if (duplicates.length > 0) {
        lines.push("", `Possible duplicates: ${duplicates.length} group(s) — run memory_prune to review:`)
        for (const g of duplicates) {
          lines.push(`- ${g.pages.join("  +  ")}  [${g.reason}]`)
        }
      }

      // Index health. Must mirror what the injection hook actually builds:
      // consolidated investigations are deliberately excluded there, so
      // counting them here would over-report omissions.
      const indexPages = pages.filter((p) => !(p.type === "Investigation" && consolidated.has(p.relPath)))
      const demoted = pages.length - indexPages.length
      const { budget, contextTokens } = getLastUsedBudget()
      const toc = deriveTOC(indexPages, budget)
      const omitted = tocTruncationCount(indexPages, budget)
      const pct = Math.round((toc.length / budget) * 100)

      // Full per-request cost of this plugin: index + matched project overview
      const project = findProjectPage(directory, pages)
      const overviewChars = project ? Math.min(project.body.length, 6_000) + 100 : 0
      const totalChars = toc.length + overviewChars
      const totalTokens = approxTokens(totalChars)

      lines.push(
        "",
        "PER-REQUEST COST OF THIS PLUGIN (injected into every message):",
        `- Index:            ${toc.length.toLocaleString()} chars  (~${approxTokens(toc.length).toLocaleString()} tokens), ${indexPages.length} page(s) listed`,
        project
          ? `- Project overview: ${overviewChars.toLocaleString()} chars  (~${approxTokens(overviewChars).toLocaleString()} tokens) — ${project.relPath}`
          : `- Project overview: none (cwd matches no project page)`,
        `- TOTAL:            ${totalChars.toLocaleString()} chars  (~${totalTokens.toLocaleString()} tokens)` +
          (contextTokens > 0
            ? ` = ${((totalTokens / contextTokens) * 100).toFixed(1)}% of this model's ${contextTokens.toLocaleString()}-token window`
            : ""),
        `- Last actually injected: ${getLastInjectedChars().toLocaleString()} chars` +
          (getLastInjectedChars() > totalChars * 1.5
            ? "  <-- LARGER THAN EXPECTED: the host may be re-injecting; report this."
            : ""),
        "",
        `Index budget: ${budget.toLocaleString()} chars (~${approxTokens(budget).toLocaleString()} tokens), ${pct}% used.` +
          (contextTokens > 0
            ? ` Derived from ${Math.round(TOC_CONTEXT_SHARE * 100)}% of the context window, capped.`
            : " (static fallback — model context unknown)"),
        demoted > 0
          ? `${demoted} consolidated investigation(s) excluded from the index — technique is in topics, originals still searchable.`
          : ""
      )
      // Version control — the recovery path when a write goes wrong
      const gitError = getLastGitError()
      lines.push(
        isGitRepo()
          ? `Version control: wiki is a git repo (every write is committed).${gitError ? ` WARNING: ${gitError}` : ""}`
          : `Version control: NOT a git repo — page writes are unrecoverable if a merge goes wrong. ` +
            `Run 'git init' in the wiki dir (or unset OPENCODE_WIKI_GIT=0).${gitError ? ` Last git error: ${gitError}` : ""}`
      )

      if (omitted > 0) {
        lines.push(
          `WARNING: ${omitted} page(s) omitted — they exist but the model never sees them in ` +
            `the index (only findable via memory_recall search). Raise OPENCODE_WIKI_TOC_SHARE, ` +
            `set OPENCODE_WIKI_TOC_BUDGET, consolidate, or prune duplicates.`
        )
      }

      return lines.join("\n")
    },
  })
}
