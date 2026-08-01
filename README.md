# opencode-memory

Wiki-style persistent memory for [OpenCode](https://opencode.ai) — a plain-markdown
knowledge base that is built automatically from your sessions and injected back into
every future session as a tiny table of contents.

## How it works

The plugin maintains a wiki of markdown pages (default `~/wiki`):

```
~/wiki/
  projects/<name>/overview.md    # per-codebase context (frontmatter: code_path)
  topics/<slug>.md               # cross-project knowledge (s3, cribl, docker...)
  investigations/<date>-<slug>.md# one-off troubleshooting write-ups
```

Every page carries YAML frontmatter with a one-line `description`. From those
descriptions the plugin derives a table of contents and injects it into the system
prompt of every session (~600-800 tokens, hard-capped) together with one rule:
*before claiming you lack knowledge or access, check the wiki via `memory_recall`.*
If the session's working directory matches a Project page's `code_path`, that
project's overview is injected too. Everything else is pulled on demand.

Knowledge capture never spends your session's context:

- **Janitor** — when a session goes idle (debounced: ≥30 min AND ≥5K new tokens),
  a child session distills the transcript delta into wiki pages, out-of-band.
- **Bootstrap** — `memory_bootstrap` seeds the wiki from this machine's *entire*
  OpenCode session history (read from OpenCode's local database), in resumable
  batches.
- **memory_write** — say "memorize this" any time; existing pages are
  read-merge-rewritten, never appended.
- **Compaction hook** — if compaction ever fires, one save request is injected.
  No periodic save nagging, ever.

Pages are validated on write: frontmatter required, one-line description required,
body capped at 150 lines. Distill, don't narrate.

## Installation

These steps are written so that an OpenCode agent can execute them directly
("clone https://github.com/omegaleon/opencode-memory and install it per its README").

### Step 1 — Clone and build

```bash
git clone https://github.com/omegaleon/opencode-memory ~/opencode-memory
cd ~/opencode-memory
npm install
npm run build
```

Verify the build produced the entry point:

```bash
ls ~/opencode-memory/dist/index.js
```

Any other clone location works — adjust the paths below to match.

### Step 2 — Register the plugin

Edit `~/.config/opencode/opencode.json` and add the built plugin to the `plugin`
array. **APPEND to the array — do not replace it.** Removing existing entries
silently disables other plugins (this exact mistake once disabled a previous
version of this plugin for months).

The path must be absolute, with the `file://` prefix (no `~`):

```json
{
  "plugin": [
    "existing-plugin-keep-me",
    "file:///home/YOUR_USER/opencode-memory/dist/index.js"
  ]
}
```

If the file has no `plugin` key yet, create it:

```json
{
  "plugin": ["file:///home/YOUR_USER/opencode-memory/dist/index.js"]
}
```

No other configuration is required — the wiki directory, injected TOC, and
recall rule all ship with the plugin. No AGENTS.md edits, no permission rules,
no instruction files.

### Step 3 — Verify the plugin is loaded

Restart OpenCode (the config is read at startup), then in a fresh session ask:

> call memory_recall with no arguments

Expected on a new machine: `The wiki is empty. Pages are created by the
background janitor, memory_write, or memory_bootstrap.` If the tool does not
exist, the plugin did not load — re-check the `file://` path and that
`dist/index.js` exists.

### Step 4 — Bootstrap from session history

In a session, say:

> run memory_bootstrap until it reports 0 remaining

It reads this machine's OpenCode session database (read-only), distills
historical sessions into wiki pages in batches of 10, and reports progress per
batch. It is resumable and idempotent — keep calling it (or letting the agent
loop) until it reports all sessions processed. Skip this step if the machine
has no session history worth mining.

### Step 5 (optional) — Git and Obsidian

```bash
git init ~/wiki    # enables automatic commit of every wiki write
```

Open `~/wiki` as an Obsidian vault to browse/search/graph the pages. Both are
optional; the plugin works identically without them.

### Troubleshooting

- **memory tools missing** — plugin not loaded: wrong `file://` path, missing
  build, or the config edit replaced instead of appended.
- **"Bootstrap unavailable"** — OpenCode's session DB was not found at
  `$XDG_DATA_HOME/opencode/opencode.db` (default
  `~/.local/share/opencode/opencode.db`), or the runtime lacks `bun:sqlite`.
  The rest of the plugin works fine without bootstrap.
- **A bootstrap session reports FAILED** — that distillation timed out or
  errored; it is retried automatically on the next `memory_bootstrap` call.
- **No `[MEMORY]` block in sessions** — the TOC is only injected once the wiki
  has at least one page.

## Tools

- `memory_recall` — no args: list all pages. `query`: keyword search.
  `page`: load one page in full.
- `memory_write` — create or update a page (`Topic` / `Investigation` / `Project`).
  Updates replace the page; the tool rejects oversized or unstructured writes.
- `memory_bootstrap` — batch-distill historical sessions into the wiki.
- `context_usage` — current token usage and context limit.

## Configuration

- `OPENCODE_WIKI_DIR` — wiki location (default `~/wiki`).
- **Git (optional)** — if the wiki dir is a git repo, every write is committed
  (`git init ~/wiki` to enable; skip it and nothing changes).
- **Obsidian (optional)** — open the wiki dir as a vault to browse/search/graph it.
  The plugin neither knows nor cares.

## Page format

```markdown
---
type: Topic
title: "s3-troubleshooting"
description: "S3 access debugging — try aws --profile default first; bucket policy vs IAM gotchas"
tags: [aws, s3]
timestamp: 2026-07-31T12:00:00Z
---

...body (max 150 lines)...
```

`description` is what appears in the injected TOC — it earns the page its
discoverability. Project pages additionally carry `code_path: /abs/path/to/repo`,
which is how sessions in that directory get the overview injected automatically.

## Development

```bash
npm run typecheck    # Type-check without emitting
npm run build        # Build to dist/
```

## License

MIT
