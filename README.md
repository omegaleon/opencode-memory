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

```bash
git clone https://github.com/omegaleon/opencode-memory
cd opencode-memory
npm install
npm run build
```

Then add to `~/.config/opencode/opencode.json` (keep existing plugins in the array):

```json
{
  "plugin": ["file:///path/to/opencode-memory/dist/index.js"]
}
```

That is the entire setup — the wiki directory, the TOC, and the recall rule all
ship with the plugin. No AGENTS.md edits, no permission config.

### Bootstrapping a new machine

Start a session and say: *"run memory_bootstrap until it finishes"*. It processes
historical sessions in batches of 10 and reports progress; repeat calls resume
where it left off.

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
