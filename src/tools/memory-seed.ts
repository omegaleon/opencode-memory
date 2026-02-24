import { tool } from "@opencode-ai/plugin/tool"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, basename } from "node:path"
import {
  writeIndexEntry,
  readIndex,
  parseIndexEntries,
  type MemoryEntry,
} from "../lib/storage.js"

/** Markers that identify a directory as a project root */
const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Makefile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Dockerfile",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "mix.exs",
  "CMakeLists.txt",
  "setup.py",
  "setup.cfg",
]

/** Skip these directories when walking */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "target",
  "vendor",
  ".cache",
  ".opencode",
])

/** Key files to read for project context, in priority order */
const KEY_FILES = [
  "README.md",
  "readme.md",
  "README",
  "README.rst",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Dockerfile",
  "Makefile",
  "setup.py",
  "setup.cfg",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "mix.exs",
]

/**
 * Find project directories under a root path.
 */
function findProjects(rootPath: string, maxDepth: number): string[] {
  const results: string[] = []

  function walk(dir: string, depth: number, isRoot: boolean = false) {
    if (depth > maxDepth) return

    try {
      const entries = readdirSync(dir, { withFileTypes: true })

      const isProject = PROJECT_MARKERS.some((marker) =>
        entries.some((e) => e.name === marker)
      )

      if (isProject && !isRoot) {
        results.push(dir)
        // Check monorepo subdirs
        if (depth < maxDepth) {
          for (const entry of entries) {
            if (!entry.isDirectory()) continue
            if (SKIP_DIRS.has(entry.name)) continue
            if (
              entry.name === "packages" ||
              entry.name === "apps" ||
              entry.name === "services" ||
              entry.name === "libs"
            ) {
              walk(join(dir, entry.name), depth + 1)
            }
          }
        }
        return
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (SKIP_DIRS.has(entry.name)) continue
        if (entry.name.startsWith(".")) continue
        walk(join(dir, entry.name), depth + 1)
      }
    } catch {
      // Permission denied — skip
    }
  }

  walk(rootPath, 0, true)
  return results
}

/**
 * Read a file safely, truncated to maxBytes.
 */
function safeRead(filePath: string, maxBytes: number = 3000): string {
  try {
    if (!existsSync(filePath)) return ""
    const content = readFileSync(filePath, "utf-8")
    return content.length > maxBytes
      ? content.slice(0, maxBytes) + "\n...(truncated)"
      : content
  } catch {
    return ""
  }
}

/**
 * Build a recursive directory tree string, limited depth.
 */
function dirTree(dir: string, prefix: string = "", depth: number = 0, maxDepth: number = 3): string {
  if (depth > maxDepth) return ""

  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => {
        if (SKIP_DIRS.has(e.name)) return false
        if (e.name.startsWith(".") && e.name !== ".env.example") return false
        return true
      })
      .sort((a, b) => {
        // Directories first, then files
        if (a.isDirectory() && !b.isDirectory()) return -1
        if (!a.isDirectory() && b.isDirectory()) return 1
        return a.name.localeCompare(b.name)
      })
      .slice(0, 25) // cap entries per level

    let result = ""
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      const isLast = i === entries.length - 1
      const connector = isLast ? "└── " : "├── "
      const childPrefix = isLast ? "    " : "│   "

      if (entry.isDirectory()) {
        result += `${prefix}${connector}${entry.name}/\n`
        result += dirTree(
          join(dir, entry.name),
          prefix + childPrefix,
          depth + 1,
          maxDepth
        )
      } else {
        result += `${prefix}${connector}${entry.name}\n`
      }
    }
    return result
  } catch {
    return ""
  }
}

/**
 * Gather all relevant context about a project for LLM analysis.
 */
function gatherProjectContext(projectDir: string): string {
  const name = basename(projectDir)
  const lines: string[] = []

  lines.push(`# Project: ${name}`)
  lines.push(`Path: ${projectDir}`)
  lines.push("")

  // Directory tree
  lines.push("## Directory Structure")
  lines.push("```")
  lines.push(`${name}/`)
  lines.push(dirTree(projectDir))
  lines.push("```")
  lines.push("")

  // Read key files
  lines.push("## Key Files")
  const readFiles = new Set<string>()
  for (const fileName of KEY_FILES) {
    const content = safeRead(join(projectDir, fileName))
    if (content) {
      readFiles.add(fileName)
      lines.push(`### ${fileName}`)
      lines.push("```")
      lines.push(content)
      lines.push("```")
      lines.push("")
    }
  }

  // Also read any .md files in the project root not already covered
  try {
    const rootFiles = readdirSync(projectDir)
      .filter((f) => f.endsWith(".md") && !readFiles.has(f))
      .slice(0, 10)
    for (const mdFile of rootFiles) {
      const content = safeRead(join(projectDir, mdFile))
      if (content) {
        lines.push(`### ${mdFile}`)
        lines.push("```")
        lines.push(content)
        lines.push("```")
        lines.push("")
      }
    }
  } catch {}

  // Check subdirectories for their own key files (e.g., client/package.json, server/package.json)
  try {
    const subdirs = readdirSync(projectDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
      .slice(0, 10)

    for (const subdir of subdirs) {
      const subPath = join(projectDir, subdir.name)
      for (const fileName of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "README.md", "AGENTS.md", "CLAUDE.md"]) {
        const content = safeRead(join(subPath, fileName), 1500)
        if (content) {
          lines.push(`### ${subdir.name}/${fileName}`)
          lines.push("```")
          lines.push(content)
          lines.push("```")
          lines.push("")
        }
      }
    }
  } catch {}

  return lines.join("\n")
}

export function createMemorySeedTool() {
  return tool({
    description:
      "Scan a directory tree for projects and seed the global memory index. " +
      "Reads each project's package.json, README, pyproject.toml, Cargo.toml, etc. " +
      "to extract: project name, languages, frameworks, description, and key topics. " +
      "Creates a memory entry for each project so future sessions can recall them. " +
      "Safe to run multiple times — existing entries are updated, not duplicated.",
    args: {
      path: tool.schema
        .string()
        .describe(
          "Root directory to scan for projects. Example: '/code' or '/home/user/projects'."
        ),
      max_depth: tool.schema
        .number()
        .optional()
        .describe("Maximum directory depth to scan. Default: 5."),
    },
    async execute(args) {
      const scanPath = args.path
      if (!existsSync(scanPath)) {
        return `Path does not exist: ${scanPath}`
      }

      const projectDirs = findProjects(scanPath, args.max_depth ?? 5)

      if (projectDirs.length === 0) {
        return `No projects found under: ${scanPath}`
      }

      const date = new Date().toISOString().slice(0, 10)

      // Gather context for each project and write basic entries to global index
      const projectContexts: string[] = []
      const seeded: string[] = []

      for (const projectDir of projectDirs) {
        const name = basename(projectDir)
        const context = gatherProjectContext(projectDir)
        projectContexts.push(context)

        // Write a placeholder entry to the global index (no local file)
        writeIndexEntry({
          date,
          sessionID: `seed-${name}`,
          project: projectDir,
          summary: `[Seeded] ${name} — awaiting LLM analysis`,
          keyTopics: name,
          decisions: "",
          sessionFilePath: "",
        })

        seeded.push(name)
      }

      // Return raw project data for the LLM to analyze
      // The LLM should review the data, then update each seed entry
      // by calling memory_save with a proper summary for each project
      const output = [
        `Found ${projectDirs.length} project(s) under ${scanPath}.`,
        `Seeded placeholder entries: ${seeded.join(", ")}`,
        "",
        "Placeholder entries written to ~/.config/opencode/memory/MEMORY.md (global index only, no local files).",
        "",
        "IMPORTANT: Review each project below and update the placeholder entries.",
        "For each project, call memory_save with project_path set to the project's path.",
        "This writes to the global index ONLY (no files created inside projects).",
        "",
        "Required memory_save args for each project:",
        "  - project_path: the project's absolute path (e.g., '/code/omegaterm')",
        "  - summary: concise description of what the project does",
        "  - key_topics: languages, frameworks, key technologies, domain",
        "  - decisions: architecture notes, deployment method, key patterns",
        "  - important_context: anything useful for future sessions working on this project",
        "",
        "The memory_save calls will update the existing seed entries with richer detail.",
        "",
        "=".repeat(80),
        "",
        projectContexts.join("\n" + "=".repeat(80) + "\n\n"),
      ]

      return output.join("\n")
    },
  })
}
