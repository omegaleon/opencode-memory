import { existsSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { getWikiDir } from "./wiki.js"

/** Last git error seen, surfaced by memory_status instead of vanishing */
let lastGitError = ""
export function getLastGitError(): string {
  return lastGitError
}

/** Whether the wiki is under version control right now */
export function isGitRepo(): boolean {
  try {
    return existsSync(join(getWikiDir(), ".git"))
  } catch {
    return false
  }
}

/**
 * Initialise the wiki as a git repo unless disabled with OPENCODE_WIKI_GIT=0.
 *
 * Every page is an LLM write into what becomes a source of truth, and the
 * failure modes are quiet by nature (a bad merge looks like a good one).
 * History is what makes that recoverable, so it is on by default rather than
 * an optional step people skip. Purely additive — it never touches an
 * existing repo and never pushes anywhere.
 */
export function ensureGitRepo(): void {
  try {
    if (process.env["OPENCODE_WIKI_GIT"] === "0") return
    const wikiDir = getWikiDir()
    if (!existsSync(wikiDir) || existsSync(join(wikiDir, ".git"))) return
    execFileSync("git", ["init", "-q"], { cwd: wikiDir, stdio: "ignore" })
    lastGitError = ""
  } catch (err) {
    lastGitError = `git init failed: ${err instanceof Error ? err.message : err}`
  }
}

/**
 * Commit wiki changes. Auto-initialises the repo on first write unless
 * disabled. Failures are recorded (see getLastGitError) rather than silently
 * swallowed — a broken repo used to mean "no history" with no indication.
 */
export function maybeCommit(message: string): void {
  try {
    ensureGitRepo()
    const wikiDir = getWikiDir()
    if (!existsSync(join(wikiDir, ".git"))) return

    execFileSync("git", ["add", "-A"], { cwd: wikiDir, stdio: "ignore" })

    // Nothing staged is a normal no-op, not an error
    try {
      execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: wikiDir, stdio: "ignore" })
      return
    } catch {
      // non-zero exit means there ARE staged changes — proceed
    }

    execFileSync("git", ["-c", "user.name=opencode-memory", "-c", "user.email=memory@localhost", "commit", "-m", message], {
      cwd: wikiDir,
      stdio: "ignore",
    })
    lastGitError = ""
  } catch (err) {
    lastGitError = `commit failed: ${err instanceof Error ? err.message : err}`
  }
}
