# opencode-memory

Persistent memory for [OpenCode](https://opencode.ai) — automatically saves session context and enables cross-session recall.

## What it does

- **Saves session context** to persistent files that survive across sessions
- **Global memory index** (`~/.config/opencode/memory/MEMORY.md`) with summaries and pointers
- **Per-project session files** (`{project}/.opencode/memory/sessions/`) with full detail
- **Three tools** for the LLM: `context_usage`, `memory_save`, `memory_recall`
- **Auto-save on compaction** — injects instructions to save context before the session is compacted
- **Context warnings** — alerts the LLM when context usage hits 60% and 80%

## Installation

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-memory"]
}
```

OpenCode will auto-install it via Bun on next startup.

## Tools

### `context_usage`

Check current context window usage. Returns token count, percentage used, and breakdown by type.

### `memory_save`

Save session context to persistent memory. Accepts:
- `summary` — what was accomplished
- `key_topics` — comma-separated topics
- `decisions` — key decisions made
- `code_changes` (optional) — files created/modified
- `important_context` (optional) — technical details for future sessions
- `unfinished` (optional) — next steps

Can be called multiple times per session — each call appends a new timestamped snapshot to the session file, so context built up before compaction is never overwritten.

### `memory_recall`

Search past sessions. Accepts:
- `query` — keywords to search, or date terms like "yesterday", "last week", "2026-02"
- `session_id` (optional) — load full detail for a specific session

Two-tier lookup: first returns summaries from the global index, then drill into full session files.

## How it works

### Storage architecture

```
~/.config/opencode/memory/
  MEMORY.md                              # Global index (all projects)

{project}/.opencode/memory/sessions/
  2026-02-23_abc12345.md                 # Full session detail
```

The global index contains reverse-chronological summaries with paths to local session files. Each project keeps its own session history.

### Automatic behaviors

1. **System prompt injection** — a save reminder is injected every ~10K tokens. At 60% context usage the reminder becomes more direct. At 80% it becomes urgent.
2. **Compaction hook** — when OpenCode triggers session compaction, the plugin injects instructions asking the LLM to save context to memory first.

## Development

```bash
git clone https://github.com/your-org/opencode-memory
cd opencode-memory
npm install
npm run typecheck    # Type-check without emitting
npm run build        # Build to dist/
```

### Local testing

For development, use a file plugin reference:

```json
{
  "plugin": ["file:///path/to/opencode-memory/dist/index.js"]
}
```

## License

MIT
