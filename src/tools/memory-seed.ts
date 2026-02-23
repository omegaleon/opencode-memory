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

interface ProjectInfo {
  path: string
  name: string
  summary: string
  topics: string[]
  languages: string[]
  frameworks: string[]
}

/**
 * Find project directories under a root path.
 */
function findProjects(rootPath: string, maxDepth: number): string[] {
  const results: string[] = []

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return

    try {
      const entries = readdirSync(dir, { withFileTypes: true })

      // Check if this directory is a project
      const isProject = PROJECT_MARKERS.some((marker) =>
        entries.some((e) => e.name === marker)
      )

      if (isProject) {
        results.push(dir)
        // Don't recurse into subprojects (monorepo packages are separate)
        // But do check one level deeper for monorepos
        if (depth < maxDepth) {
          for (const entry of entries) {
            if (!entry.isDirectory()) continue
            if (SKIP_DIRS.has(entry.name)) continue
            // Only recurse into common monorepo patterns
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

      // Not a project, keep walking
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

  walk(rootPath, 0)
  return results
}

/**
 * Read a file safely, return empty string on failure.
 */
function safeRead(filePath: string, maxBytes: number = 4096): string {
  try {
    if (!existsSync(filePath)) return ""
    const stat = statSync(filePath)
    if (stat.size > maxBytes * 2) {
      // Read only the beginning for large files
      const buf = Buffer.alloc(maxBytes)
      const fd = require("node:fs").openSync(filePath, "r")
      require("node:fs").readSync(fd, buf, 0, maxBytes, 0)
      require("node:fs").closeSync(fd)
      return buf.toString("utf-8")
    }
    return readFileSync(filePath, "utf-8")
  } catch {
    return ""
  }
}

/**
 * Analyze a project directory and extract key information.
 */
function analyzeProject(projectDir: string): ProjectInfo {
  const name = basename(projectDir)
  const languages: string[] = []
  const frameworks: string[] = []
  const topics: string[] = []
  const summaryParts: string[] = []

  // Read package.json
  const pkgJson = safeRead(join(projectDir, "package.json"))
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson)
      languages.push("JavaScript/TypeScript")
      if (pkg.description) summaryParts.push(pkg.description)

      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      }
      // Detect frameworks from dependencies
      if (allDeps?.react) frameworks.push("React")
      if (allDeps?.next) frameworks.push("Next.js")
      if (allDeps?.vue) frameworks.push("Vue")
      if (allDeps?.nuxt) frameworks.push("Nuxt")
      if (allDeps?.svelte) frameworks.push("Svelte")
      if (allDeps?.express) frameworks.push("Express")
      if (allDeps?.fastify) frameworks.push("Fastify")
      if (allDeps?.nestjs || allDeps?.["@nestjs/core"]) frameworks.push("NestJS")
      if (allDeps?.electron) frameworks.push("Electron")
      if (allDeps?.typescript) languages.push("TypeScript")
      if (allDeps?.tailwindcss) frameworks.push("Tailwind")
      if (allDeps?.prisma || allDeps?.["@prisma/client"]) frameworks.push("Prisma")
      if (allDeps?.drizzle || allDeps?.["drizzle-orm"]) frameworks.push("Drizzle")
      if (allDeps?.mongoose) frameworks.push("Mongoose")
      if (allDeps?.["@opencode-ai/plugin"]) frameworks.push("OpenCode Plugin")

      // Scripts as topic hints
      if (pkg.scripts) {
        const scriptNames = Object.keys(pkg.scripts)
        if (scriptNames.includes("test")) topics.push("tests")
        if (scriptNames.includes("deploy")) topics.push("deployment")
        if (scriptNames.includes("lint")) topics.push("linting")
      }
    } catch {
      // Invalid JSON
    }
  }

  // Read pyproject.toml / setup.py
  const pyproject = safeRead(join(projectDir, "pyproject.toml"))
  if (pyproject) {
    languages.push("Python")
    const nameMatch = pyproject.match(/^name\s*=\s*"(.+)"/m)
    const descMatch = pyproject.match(/^description\s*=\s*"(.+)"/m)
    if (descMatch) summaryParts.push(descMatch[1]!)

    if (pyproject.includes("django")) frameworks.push("Django")
    if (pyproject.includes("flask")) frameworks.push("Flask")
    if (pyproject.includes("fastapi")) frameworks.push("FastAPI")
    if (pyproject.includes("boto3")) frameworks.push("AWS/boto3")
    if (pyproject.includes("elasticsearch")) frameworks.push("Elasticsearch")
    if (pyproject.includes("pandas")) frameworks.push("Pandas")
    if (pyproject.includes("sqlalchemy")) frameworks.push("SQLAlchemy")
  }

  const setupPy = safeRead(join(projectDir, "setup.py"))
  if (setupPy && !languages.includes("Python")) {
    languages.push("Python")
  }

  // Read Cargo.toml
  const cargoToml = safeRead(join(projectDir, "Cargo.toml"))
  if (cargoToml) {
    languages.push("Rust")
    const descMatch = cargoToml.match(/^description\s*=\s*"(.+)"/m)
    if (descMatch) summaryParts.push(descMatch[1]!)
  }

  // Read go.mod
  const goMod = safeRead(join(projectDir, "go.mod"))
  if (goMod) {
    languages.push("Go")
  }

  // Read README (first 2000 chars for summary extraction)
  const readmeNames = ["README.md", "readme.md", "README", "README.rst", "README.txt"]
  for (const readmeName of readmeNames) {
    const readme = safeRead(join(projectDir, readmeName), 2000)
    if (readme) {
      // Extract first paragraph as description
      const firstPara = readme
        .replace(/^#[^\n]*\n+/, "") // strip title
        .replace(/^\[.*?\].*\n*/gm, "") // strip badges
        .replace(/^>\s.*\n*/gm, "") // strip blockquotes
        .trim()
        .split(/\n\n/)[0]

      if (firstPara && firstPara.length > 10 && firstPara.length < 500) {
        summaryParts.push(firstPara.replace(/\n/g, " "))
      }
      break
    }
  }

  // Check for Docker
  if (
    existsSync(join(projectDir, "Dockerfile")) ||
    existsSync(join(projectDir, "docker-compose.yml")) ||
    existsSync(join(projectDir, "docker-compose.yaml"))
  ) {
    topics.push("Docker")
  }

  // Check for CI/CD
  if (existsSync(join(projectDir, ".github", "workflows"))) {
    topics.push("GitHub Actions")
  }
  if (existsSync(join(projectDir, ".gitlab-ci.yml"))) {
    topics.push("GitLab CI")
  }

  // Check for Terraform/IaC
  try {
    const files = readdirSync(projectDir)
    if (files.some((f) => f.endsWith(".tf"))) {
      topics.push("Terraform")
      languages.push("HCL")
    }
  } catch {}

  // Build the directory listing for context
  try {
    const topLevel = readdirSync(projectDir)
      .filter((f) => !f.startsWith(".") && f !== "node_modules")
      .slice(0, 30)
    topics.push(...topLevel.filter((f) => {
      try {
        return statSync(join(projectDir, f)).isDirectory()
      } catch { return false }
    }).map((d) => `dir:${d}`))
  } catch {}

  // Build summary
  const summary = summaryParts.length > 0
    ? summaryParts[0]!
    : `${languages.join("/")} project`

  return {
    path: projectDir,
    name,
    summary: summary.slice(0, 300),
    topics: [...new Set(topics)],
    languages: [...new Set(languages)],
    frameworks: [...new Set(frameworks)],
  }
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

      const existingContent = readIndex()
      const existingEntries = parseIndexEntries(existingContent)
      const existingProjects = new Set(
        existingEntries
          .filter((e) => e.sessionID.startsWith("seed-"))
          .map((e) => e.project)
      )

      let added = 0
      let updated = 0
      const details: string[] = []

      const date = new Date().toISOString().slice(0, 10)

      for (const projectDir of projectDirs) {
        const info = analyzeProject(projectDir)

        const topicsStr = [
          ...info.languages,
          ...info.frameworks,
          ...info.topics.filter((t) => !t.startsWith("dir:")),
        ].join(", ")

        const dirTopics = info.topics
          .filter((t) => t.startsWith("dir:"))
          .map((t) => t.replace("dir:", ""))

        const entry: MemoryEntry = {
          date,
          sessionID: `seed-${info.name}`,
          project: projectDir,
          summary: info.summary,
          keyTopics: topicsStr || info.name,
          decisions: `Languages: ${info.languages.join(", ") || "unknown"}. Frameworks: ${info.frameworks.join(", ") || "none detected"}.${dirTopics.length > 0 ? ` Key dirs: ${dirTopics.join(", ")}` : ""}`,
          sessionFilePath: "",
        }

        const isUpdate = existingProjects.has(projectDir)
        writeIndexEntry(entry)

        if (isUpdate) {
          updated++
        } else {
          existingProjects.add(projectDir)
          added++
        }

        details.push(
          `  ${info.name} (${projectDir})` +
          `\n    ${info.summary.slice(0, 100)}` +
          `\n    [${info.languages.join(", ")}] [${info.frameworks.join(", ")}]`
        )
      }

      const lines = [
        `Seed complete.`,
        ``,
        `Projects found: ${projectDirs.length}`,
        `Added to memory: ${added}`,
        `Updated: ${updated}`,
        ``,
        `Projects:`,
        ...details,
      ]

      return lines.join("\n")
    },
  })
}
