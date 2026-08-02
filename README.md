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
  OpenCode session history (read from OpenCode's local database). Runs detached
  in the background; the session stays free and progress is polled on demand.
- **memory_write** — say "memorize this" any time; existing pages are
  read-merge-rewritten, never appended.
- **Compaction hook** — if compaction ever fires, one save request is injected.
  No periodic save nagging, ever.

Pages are validated on write: frontmatter required, one-line description required,
body capped at 150 lines. Distill, don't narrate.

**Credentials never reach disk.** Every write passes through a redaction filter
(AWS keys, private key blocks, bearer tokens/JWTs, vendor API keys, passwords in
URLs or assignments). It is deliberately narrow — account IDs, ARNs, bucket names,
hostnames and env-var *names* are valuable content and are left untouched — and
every redaction is reported in the write result, never silent.

**Investigations feed topics.** An incident write-up usually contains technique
that outlives it (query scoping rules, tool flags, access patterns). The distiller
is required to emit both: the Investigation for the narrative *and* a Topic
carrying the reusable part, standalone. `memory_consolidate` does the same sweep
retroactively over investigations that predate this behaviour — it only ever adds
or merges topics, and never modifies or deletes an investigation.

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

> run memory_bootstrap

It reads this machine's OpenCode session database (read-only) and starts a
**background run** — the tool returns immediately and the session stays free
while historical sessions are distilled into wiki pages one by one,
checkpointed as it goes. Then:

- *"how's the bootstrap going?"* → the model calls `action="status"` for an
  instant progress report (also visible in `{wiki}/.memory-state.json`)
- *"stop the bootstrap"* → `action="cancel"`, stops between sessions;
  starting again later resumes where it left off

It is resumable and idempotent — processed sessions are never redone, and a
crash or restart mid-run loses at most the one session being distilled. Skip
this step if the machine has no session history worth mining.

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
- **Status shows FAILED sessions** — those distillations timed out or errored;
  they are not marked done and are retried automatically on the next
  `memory_bootstrap` run.
- **No `[MEMORY]` block in sessions** — the TOC is only injected once the wiki
  has at least one page.

## Tools

- `memory_recall` — no args: list all pages. `query`: keyword search.
  `page`: load one page in full. `type` / `tag`: filters.
- `memory_write` — create or update a page (`Topic` / `Investigation` / `Project`).
  Updates replace the page; the tool rejects oversized or unstructured writes.
- `memory_bootstrap` — `action=start|status|cancel`; background distillation of
  historical sessions.
- `memory_consolidate` — `action=start|status|cancel`; background promotion of
  reusable technique out of investigations into topics (additive; nothing is
  deleted).
- `memory_status` — page counts, recent writes, whether this session has been
  harvested, sessions pending a bootstrap sweep, duplicate groups, index-budget
  health.
- `memory_prune` — report duplicate/overlapping pages; delete one after
  explicit user approval (dry run by default).
- `context_usage` — current token usage and context limit.

## Index sizing and growth

The injected index carries one line per page (`slug: description`), averaging
~160 chars / ~40 tokens. The budget is **60,000 chars (~15K tokens, ~350
pages)** — a few percent of a modern context window, spent on the one thing
that makes the wiki work: a page missing from the index is a page the model
never learns exists.

Growth is bounded by **distinct subjects, not session count**:

- **Topics merge instead of multiplying.** Before writing, the distiller is
  shown the index plus the full content of the pages most likely to match, and
  is required to merge rather than create near-duplicates. Ten sessions about
  Cribl backpressure converge on one page.
- **Project pages are keyed on `code_path`**, so one repo can only ever have
  one overview no matter what slug a distiller invents.
- **Investigations leave the index once consolidated.** `memory_consolidate`
  promotes their reusable technique into topics; the incident file stays on
  disk and stays searchable, but stops occupying index space. This is what
  keeps per-session artifacts from accumulating in the always-loaded surface.
- **Duplicates are detected and prunable.** `memory_status` reports pages
  sharing a `code_path` or differing only by a generic slug affix;
  `memory_prune` removes the leftover after you approve a merge.

If the index ever exceeds budget, `memory_status` says so explicitly (pages
are never dropped silently). Raise it with `OPENCODE_WIKI_TOC_BUDGET`, or
consolidate and prune to reclaim space.

## Configuration

- `OPENCODE_WIKI_DIR` — wiki location (default `~/wiki`).
- `OPENCODE_WIKI_TOC_BUDGET` — max chars for the injected index
  (default `60000`).
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

## Changelog

Newest first, stamped in UTC. See `git log` for full detail.

### 2026-08-02T20:02Z — status/index consistency

- `memory_status` was computing index truncation over *all* pages while the
  injection hook excludes consolidated investigations, so it over-reported
  omissions. Status now mirrors exactly what gets injected and reports how
  many investigations were excluded.

### 2026-08-02T19:56Z — index sizing, duplicate detection, pruning

- **Fixed premature index truncation.** The per-section budget split the total
  evenly across page types, so a wiki with many topics and few projects
  truncated topics at ~1/3 of the budget while total usage still looked low
  (box 2 reported 11,963/14,000 chars *with 86 pages omitted*). Replaced with
  max-min fair allocation: sections needing less than an equal share take only
  what they need and hand the rest back. Measured after the fix: 174 pages →
  0 omitted; 454 pages → 100% budget utilization with every section present.
- **Index budget 14,000 → 60,000 chars** (~15K tokens, ~350 pages) and
  overridable with `OPENCODE_WIKI_TOC_BUDGET`. The old value was fitted to a
  one-time measurement of box 2's wiki rather than derived from anything.
- **Consolidated investigations drop out of the index.** Once an
  investigation's reusable technique has been promoted into topics, listing
  the incident too spends index space on a second copy. The file stays on
  disk and stays searchable via `memory_recall`. This is the main brake on
  index growth — bounded by *distinct topics*, not by session count.
- **`memory_status` reports duplicates**: project pages sharing a `code_path`,
  and same-type pages whose slugs differ only by a generic affix
  (`-overview`, `-notes`, `-guide`…).
- **New `memory_prune` tool** — the wiki had no delete path, so duplicates
  were unresolvable. Dry run by default: it returns the page's full content
  for review and refuses to delete without an explicit `confirm=true` after
  user approval.

### 2026-08-02T18:30Z

- **Background job runner** (`bcb42cb`) — `memory_consolidate` no longer runs
  inline. Both long-running jobs (bootstrap, consolidate) share one detached
  runner with `action=start|status|cancel`; a job returns control to the
  session immediately and checkpoints per item. One job at a time process-wide;
  the janitor pauses while any job runs.
- **Credential redaction, investigation promotion, status tool** (`dd1b836`)
  - Secrets are stripped at `writePage`, the single write choke point.
    Deliberately narrow: AWS keys, private-key blocks, JWT/bearer tokens,
    vendor API keys, URL and assigned passwords. Account IDs, ARNs, bucket
    names, hostnames and env-var *names* are never touched. Redactions are
    always reported, never silent.
  - Investigations are listed individually in the injected index (previously a
    bare count, which buried reusable technique), and the distiller must now
    dual-extract: the Investigation narrative **and** a standalone Topic
    carrying the technique.
  - New `memory_consolidate` mines pre-existing investigations for technique
    (purely additive — never modifies or deletes an investigation).
  - New `memory_status`: page counts, recent writes, whether this session has
    been harvested, sessions pending a sweep, index-budget health.
  - Distiller improvements: candidate pages injected in full before generation,
    anti-rot rules, no-credentials rule, contradiction/supersession handling.
  - `source_sessions` provenance frontmatter; `memory_recall` `type`/`tag`
    filters; `listPages()` cached with invalidate-on-write.

### 2026-08-01T22:00Z

- **Stronger recall rule** (`0acef33`) — the injected rule now fires on topic
  match, not only when the model is about to claim ignorance.
- **Tuning pass from the box-2 acceptance test** (`45ef661`)
  - Project page identity is `code_path`, not the model-chosen slug — fixes
    duplicate pages for one repo.
  - Index budget raised 3,200 → 14,000 chars with a compact sectioned format;
    the old budget silently hid ~75% of an 89-page wiki.
  - Bootstrap detached with `start|status|cancel`.

### 2026-07-31T21:30Z — v2 rewrite

- **Wiki-style memory** (`7390795`) — replaced v1 entirely. Derived TOC
  injection, `code_path`-matched project overviews, idle-triggered background
  janitor, full session-history bootstrap, validated `memory_write`
  (frontmatter + 150-line cap + replace-only semantics). Removed v1's
  10K/60%/80% save nagging, snapshot-append session files, and `memory_seed`.
- Install runbook in this README (`93c8a9b`); concurrency guard and progress
  relay for bootstrap (`b5d02c2`, `0ff49d3`).

### 2026-02-23T00:00Z — v1 (superseded)

Chronological session logs in `~/.config/opencode/memory/MEMORY.md` plus
per-project session files, with in-session save reminders at 10K-token and
60%/80% context thresholds. The reminders fired on every request past the
threshold and blew up context windows; the whole approach was removed in v2.

## Design sources

This plugin borrows deliberately. Credit where it is due:

- **The OKF / Obsidian vault pattern** — YAML frontmatter with
  `type`/`title`/`description`/`tags`/`timestamp`, plain markdown as the
  storage format, a vault browsable in Obsidian and versioned in git.
- **A colleague's personal engineering wiki** — the two-tier split between
  per-codebase project pages and cross-project platform knowledge, the
  `code_path` field mapping a wiki page to a repo, and the
  investigation → runbook promotion ladder. These are the best ideas in the
  design; this plugin's contribution is enforcing them in code rather than in
  prose instructions.
- **Researched systems** — mem0 (extraction pipeline, anti-rot prompt rules,
  candidate-context lookup), Letta/MemGPT (git-versioned markdown memory,
  store pointers not retellings), basic-memory (frontmatter as a filterable
  index), Anthropic's Claude Code memory (index file + on-demand topic files,
  and its explicit guidance that credential stripping is the implementer's
  job). Full comparison and the explicit reject list — vector DB, knowledge
  graph, wikilinks, hard TTLs — are in `RESEARCH-memory-systems.md`.

## License

MIT
