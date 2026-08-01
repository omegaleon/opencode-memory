import { existsSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { getWikiDir } from "./wiki.js"

/**
 * Commit wiki changes if (and only if) the wiki dir is a git repo.
 * Git is optional by design — absence of .git makes this a silent no-op.
 */
export function maybeCommit(message: string): void {
  try {
    const wikiDir = getWikiDir()
    if (!existsSync(join(wikiDir, ".git"))) return

    execFileSync("git", ["add", "-A"], { cwd: wikiDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", message], { cwd: wikiDir, stdio: "ignore" })
  } catch {
    // Nothing staged, git missing, etc. — never block the host application
  }
}
