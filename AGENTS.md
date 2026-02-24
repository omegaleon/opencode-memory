# AGENTS.md — opencode-memory

## Project Overview

OpenCode plugin that provides persistent memory across sessions. It auto-saves session
context, maintains a global memory index (`~/.config/opencode/memory/MEMORY.md`), and
stores per-project session files (`{project}/.opencode/memory/sessions/`).

Small TypeScript project (~11 source files, ~900 LOC) built as an ESM plugin for the
`@opencode-ai/plugin` SDK. No external runtime dependencies beyond the SDK.

## Build & Typecheck

```bash
npm run build        # Compile TypeScript to dist/ (runs tsc)
npm run typecheck    # Type-check without emitting (tsc --noEmit)
```

There is no linter, formatter, CI pipeline, or test suite configured.

## Project Structure

```
src/
├── index.ts              # Plugin entry point, exports MemoryPlugin (default)
├── hooks/
│   ├── compaction.ts     # Auto-save on session compaction
│   ├── events.ts         # Event tracking + auto-save every ~10K tokens
│   └── system.ts         # Context % warnings injected into system prompt
├── lib/
│   ├── context.ts        # getContextUsage() — queries messages + config.providers
│   ├── extract.ts        # extractSessionData() — parses messages directly, no LLM call
│   ├── search.ts         # searchEntries() + filterByDate() — keyword scoring
│   └── storage.ts        # readIndex/writeIndexEntry/writeSessionFile/readSessionFile
└── tools/
    ├── context-usage.ts  # context_usage tool definition
    ├── memory-recall.ts  # memory_recall tool definition
    ├── memory-save.ts    # memory_save tool definition
    └── memory-seed.ts    # memory_seed tool definition
```

## Architecture

- **Plugin factory pattern**: `MemoryPlugin` is typed as `const MemoryPlugin: Plugin` — an async
  function receiving `{ client, directory }` and returning `{ tool, event, hooks }` registrations.
- **Shared mutable state**: A `SessionTracker` object is passed by reference to hooks for
  coordinating session ID tracking and auto-save thresholds (`AUTO_SAVE_INTERVAL = 10_000` tokens).
- **Markdown as data format**: Both the global index and session files are plain Markdown, parsed
  and written with regex and string concatenation. No JSON/YAML storage.
- **Synchronous file I/O**: Uses `readFileSync`/`writeFileSync` from `node:fs`.
- **No classes**: Everything is plain functions and interfaces.
- **Tool definitions**: Use `tool()` from `@opencode-ai/plugin/tool` with `tool.schema` (Zod v4)
  for argument schemas.
- **Hook names**: Hooks use the `experimental.*` namespace —
  `"experimental.session.compacting"` and `"experimental.chat.system.transform"`.

## SDK & Runtime

- **SDK**: `@opencode-ai/plugin@1.2.10` — provides `Plugin`, `Hooks`, `PluginInput` types and
  the `tool()` builder. Import tool builder from `@opencode-ai/plugin/tool`.
- **Zod**: v4.1.8 (bundled by SDK) — note Zod v4 has API differences from v3.
- **TypeScript**: v5.9.x, `strict: true`, target ES2022, module ESNext, moduleResolution bundler.
- **Types**: `bun-types` is included in devDependencies (bun globals are available), but the
  host runtime is OpenCode's plugin sandbox, not a standalone Bun/Node process.

## Storage Paths

- **Global index**: `~/.config/opencode/memory/MEMORY.md`
- **Session files**: `{project}/.opencode/memory/sessions/{YYYY-MM-DD}_{shortID}.md`
- `memory_seed` writes to the global index only (no local session file), using `project_path`
  override on `memory_save`.

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

- The global memory index is a single Markdown file, not a database — keeps things
  portable and human-readable
- Session files are per-project to avoid leaking context across unrelated projects
- Auto-save on compaction extracts data directly from messages without an LLM call,
  then asks the LLM to enrich via a follow-up `memory_save` call
- Context usage warnings are injected at 60% and 80% thresholds via system prompt transform
- `memory_seed` writes placeholder entries first, returns raw project context for the LLM
  to enrich by calling `memory_save` with `project_path` for each discovered project
- `memory_recall` is two-tier: global index search first (fast keyword scoring), then
  `session_id` drill-down loads the full local session file

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
