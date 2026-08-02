# AGENTS.md — opencode-memory

## Project Overview

OpenCode plugin that provides wiki-style persistent memory across sessions. It maintains
a plain-markdown wiki (default `~/wiki`, override `OPENCODE_WIKI_DIR`) of topic pages,
investigation notes, and per-project overviews. A derived table of contents plus a recall
rule is injected into every session's system prompt; knowledge capture runs out-of-band
(idle-triggered janitor, batch bootstrap from OpenCode's session database) so the live
session's context never pays for it. See `PLAN.md` for the full design rationale.

Small TypeScript project built as an ESM plugin for the `@opencode-ai/plugin` SDK.
No external runtime dependencies beyond the SDK (bootstrap uses `bun:sqlite`, which
ships with the Bun runtime OpenCode plugins execute in).

## Build & Typecheck

```bash
npm run build        # Compile TypeScript to dist/ (runs tsc)
npm run typecheck    # Type-check without emitting (tsc --noEmit)
```

There is no linter, formatter, CI pipeline, or test suite configured.

## Project Structure

```
src/
├── index.ts               # Plugin entry point, exports MemoryPlugin (default)
├── hooks/
│   ├── inject.ts          # Derived TOC + recall rule + project overview injection
│   ├── janitor.ts         # session.idle → out-of-band transcript distillation
│   └── compaction.ts      # Single last-ditch save request if compaction fires
├── lib/
│   ├── wiki.ts            # Page model: frontmatter parse/serialize, validation, TOC derivation
│   ├── redact.ts          # Narrow credential redaction applied at the write choke point
│   ├── distill.ts         # Child-session distillation + read-merge-rewrite of pages
│   ├── transcript.ts      # Compact transcript rendering from session messages
│   ├── state.ts           # Janitor cursors + bootstrap progress ({wiki}/.memory-state.json)
│   ├── db.ts              # Read-only bun:sqlite access to OpenCode's session DB (bootstrap)
│   ├── git.ts             # Optional git commit of wiki writes (no-op without .git)
│   └── context.ts         # getContextUsage() — queries messages + config.providers
└── tools/
    ├── context-usage.ts   # context_usage tool definition
    ├── memory-recall.ts   # List/search/load wiki pages
    ├── memory-write.ts    # Validated page write (replace semantics, size caps)
    └── memory-bootstrap.ts# Batch-distill historical sessions into the wiki
```

## Architecture

- **Plugin factory pattern**: `MemoryPlugin` is typed as `const MemoryPlugin: Plugin` — an async
  function receiving `{ client, directory }` and returning `{ tool, event, hooks }` registrations.
- **Tiny always-loaded surface**: the ONLY per-session cost is one system-prompt injection
  (derived TOC + recall rule + matching project overview, hard character budgets). All capture
  is out-of-band via child sessions (`client.session.create` with `parentID` + `session.prompt`).
- **Derived, never maintained**: the TOC is generated from page frontmatter at read time.
  There is no index file to drift.
- **Read-merge-rewrite**: pages are always fully replaced, never appended. Merging with
  existing content is done by the distiller LLM (janitor/bootstrap) or demanded of the
  calling model (`memory_write` description). `validatePage` enforces frontmatter and the
  150-line body cap by rejecting writes.
- **Markdown + YAML frontmatter as data format**, parsed with regex (flat subset, not a
  general YAML parser). Obsidian/OKF-compatible by convention, no dependency.
- **Synchronous file I/O**: Uses `readFileSync`/`writeFileSync` from `node:fs`.
- **No classes**: Everything is plain functions and interfaces.
- **Tool definitions**: Use `tool()` from `@opencode-ai/plugin/tool` with `tool.schema` (Zod v4)
  for argument schemas.
- **Hook names**: `event` (session.idle janitor), `experimental.chat.system.transform`
  (injection), `experimental.session.compacting` (last-ditch capture).

## SDK & Runtime

- **SDK**: `@opencode-ai/plugin@1.2.10` — provides `Plugin`, `Hooks`, `PluginInput` types and
  the `tool()` builder. Import tool builder from `@opencode-ai/plugin/tool`.
- **Zod**: v4.1.8 (bundled by SDK) — note Zod v4 has API differences from v3.
- **TypeScript**: v5.9.x, `strict: true`, target ES2022, module ESNext, moduleResolution bundler.
- **Types**: `bun-types` is included in devDependencies (bun globals are available), but the
  host runtime is OpenCode's plugin sandbox, not a standalone Bun/Node process.

## Storage Paths

- **Wiki root**: `~/wiki` (override with `OPENCODE_WIKI_DIR`)
  - `projects/<name>/overview.md` — per-codebase context, frontmatter `code_path` maps to repo
  - `topics/<slug>.md` — cross-project knowledge
  - `investigations/<YYYY-MM-DD>-<slug>.md` — one-off troubleshooting notes
  - `.memory-state.json` — janitor cursors, bootstrap progress, plugin session IDs
- **Session history source (bootstrap, read-only)**: `$XDG_DATA_HOME/opencode/opencode.db`
  (default `~/.local/share/opencode/opencode.db`) — `session`/`message`/`part` tables,
  internal schema, every access failure degrades gracefully.

## Code Style

### TypeScript & Compiler

- `strict: true` — no implicit `any`, strict null checks, all strict flags on
- Target: ES2022, Module: ESNext, moduleResolution: bundler
- Declaration files are emitted alongside `.js` to `dist/`
- Numeric separators are used for readability: `10_000`

### Formatting

- 2-space indentation
- No semicolons
- Template literals for string interpolation
- String concatenation with `+` for multi-line tool description strings
- Trailing commas in multi-line objects and arrays
- No configured formatter (no Prettier/Biome) — follow existing patterns

### Imports

- **Type-only imports** use a separate `import type { X }` statement from value imports
- **Value imports** use named imports: `import { foo } from "module"`
- **Local imports must include `.js` extension** (ESM requirement): `import { bar } from "./lib/storage.js"`
- Node builtins use the `node:` prefix: `import { readFileSync } from "node:fs"`
- Order: external packages first, then local imports

### Naming Conventions

- **Files**: kebab-case (`memory-save.ts`, `context-usage.ts`)
- **Directories**: lowercase single words (`hooks/`, `lib/`, `tools/`)
- **Interfaces**: PascalCase (`MemoryEntry`, `SessionDetail`, `ContextInfo`, `SessionTracker`)
- **Functions**: camelCase; factory functions prefixed with `create` (`createMemorySaveTool`)
- **Module-level constants**: UPPER_SNAKE_CASE (`MEMORY_DIR`, `INDEX_FILE`, `AUTO_SAVE_INTERVAL`)
- **Variables**: camelCase
- **Internal helpers**: camelCase without prefix (`ensureDir`, `formatDate`, `escapeRegex`)

### Exports

- Named exports for all public functions and interfaces
- Only `src/index.ts` uses a default export (`export default MemoryPlugin`)
- No barrel/index re-exports from subdirectories

### Error Handling

- **Catch-and-swallow pattern**: bare `catch {}` blocks that silently ignore all errors
- This is intentional — plugin failures must never block the host application
- Functions that can fail return `null` (or `Promise<T | null>`) rather than throwing
- No custom error classes, no error logging, no error propagation

```typescript
// Correct pattern for this codebase:
try {
  const data = await extractSessionData(client, sessionID, directory)
  if (data) { /* use data */ }
} catch {
  // Don't block host application if memory save fails
}
```

### Type Assertions

- `as any` is used freely for untyped SDK properties (acceptable given the plugin SDK's loose typing)
- Non-null assertion `!` is used sparingly — primarily in regex match destructuring
- Optional chaining `?.` and nullish coalescing `??` are used heavily
- No generics, utility types, or enums in the codebase

```typescript
// Common pattern for accessing untyped SDK fields:
const filePath = (state.input as any).filePath
  ?? (state.input as any).file_path
  ?? (state.input as any).path
```

### Function Signatures

- Factory functions take `client: PluginInput["client"]` (not a standalone typed alias)
- Hook factories return `Hooks["hook.name"]` type directly
- Tool factories return the result of `tool({ ... })` from `@opencode-ai/plugin/tool`
- Async functions return `Promise<T | null>` for fallible operations

### JSDoc Comments

- Block `/** ... */` style used on every exported function and non-obvious constants
- Inline `//` comments used within function bodies for step-by-step explanation
- No `@param`/`@returns` tags — prose descriptions only

## Commit Style

- Imperative mood, concise subject line
- No conventional-commits prefix (no `feat:`, `fix:`, etc.)
- Examples from history:
  - `Add memory_seed tool: one-time scan to bootstrap global index`
  - `Fix seed to always recurse from root scan path`
  - `Add automatic memory saves: extract on compaction + save every 10K tokens`
  - `Add project_path to memory_save for global-only writes`

## Key Design Decisions

- **No in-session save nagging** — v1's 10K/60%/80% token-threshold save reminders blew up
  context windows and are permanently removed. Capture is out-of-band only.
- **Janitor debounce**: harvest a session only if ≥30 min since last harvest AND ≥5K token
  growth (`HARVEST_MIN_INTERVAL_MS`, `HARVEST_MIN_TOKEN_GROWTH` in hooks/janitor.ts) —
  robust to whatever frequency `session.idle` fires at.
- **Bootstrap is sequential on purpose**: distillations share wiki state (later merges must
  see earlier writes) and target one LLM provider — parallel child sessions would race
  merges and trip rate limits. It is resumable via `.memory-state.json` instead of fast.
- **Distiller output protocol**: child sessions emit `## PAGE: <type> ... ## END` blocks
  parsed by `parseBlocks()` (lib/distill.ts). Merging with an existing page is a follow-up
  prompt in the same child session that returns the full replacement page.
- **`description` frontmatter is the TOC** — one line, ≤200 chars, enforced at write time.
  A page's discoverability lives or dies on it.
- **Git optional**: `maybeCommit()` is a silent no-op unless `{wiki}/.git` exists.
- **The recall rule ships in the injection**, not in AGENTS.md/instructions — the plugin
  is fully self-contained (one config line to install on a new machine).
- **Plugins cannot register slash commands** (verified against SDK 1.2.10/1.2.27) — there
  is no `/memorize`; users say "memorize this" and the model calls `memory_write`.

## Common Patterns

### Adding a new tool

1. Create `src/tools/my-tool.ts` with a `createMyTool` factory function
2. Import `tool` from `@opencode-ai/plugin/tool`; define args with `tool.schema` (Zod v4)
3. Register it in `src/index.ts` under the `tool` object
4. Run `npm run typecheck` to verify

### Adding a new hook

1. Create or extend a file in `src/hooks/`
2. Export a `createXHook` factory that returns the appropriate `Hooks["experimental.*"]` type
3. Wire it up in `src/index.ts`
4. The hook receives `(input, output)` — mutate `output` to inject context
