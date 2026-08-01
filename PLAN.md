# PLAN — opencode-memory v2: Wiki-Style Persistent Memory

Status: DESIGN APPROVED (pending 3 minor decisions below). No implementation started.

## Problem with v1 (current code in this repo)

v1 blew up context windows. Root causes, all verified in code:

1. `src/hooks/system.ts:24-35` — 60%/80% branches inject a save nag on EVERY chat
   request once threshold crossed (not gated on growth). Model obeys repeatedly.
2. Every `memory_save` costs a multi-hundred-word summary in tool args + result,
   accumulating in live context.
3. `src/tools/memory-seed.ts` returns ALL projects' trees/READMEs/manifests in ONE
   tool result (tens of thousands of tokens), then demands per-project saves.
4. `memory_recall` returns up to 20 full paragraph entries; session files append
   snapshots forever and grow unboundedly.
5. Write path is push-based (nag to save); read path is passive (nothing ever
   tells the model to recall). Backwards: expensive writes, no reads.

Also: v1 was silently disabled ~Mar-Jun 2026 — a config rewrite dropped it from
the `plugin` array in `~/.config/opencode/opencode.json` when opencode-claude-auth
was added. Nobody noticed because recall never happened anyway.

## v2 Design Principles

- Tiny always-loaded surface (TOC + matched project overview), everything else
  pulled on demand.
- All knowledge WRITING happens out-of-band (never spends live-session context).
- Machinery over rules: everything that must happen reliably is code, not prose.
  Exactly ONE behavioral rule remains (recall-before-claiming-ignorance).
- Wiki = plain markdown + YAML frontmatter. Obsidian-compatible by accident,
  not by dependency. Portable, human-readable, tool-agnostic.
- TOC is DERIVED from page frontmatter at read time. Never a maintained file.
- Pages are read-merge-rewritten, never appended. Size caps enforced by the
  write tool (reject + "distill harder"), not by convention.

## Storage Layout

```
~/wiki/                          # location configurable; plain dir, no deps
  projects/
    <name>/overview.md           # per-codebase context; frontmatter code_path
  topics/
    <slug>.md                    # cross-project knowledge (s3, cribl, sqs...)
  investigations/
    <YYYY-MM-DD>-<slug>.md       # raw janitor/bootstrap output; low quality bar
```

Flat `topics/` to start — per-platform subdirs only if volume demands (structure
is earned). Git optional: if the dir is a repo, tools commit after writes; if
not, they don't care. NOT a hard requirement.

### Frontmatter (OKF-compatible)

```yaml
---
type: Project | Topic | Investigation
title: "..."
description: "one line — THIS feeds the derived TOC"
tags: [lowercase]
timestamp: ISO-8601
code_path: /code/loltracker      # Project pages only; join key to cwd
---
```

## Components (all SDK capabilities verified against @opencode-ai/plugin 1.2.27)

| # | Component        | Mechanism                                    |
|---|------------------|----------------------------------------------|
| 1 | TOC injection    | experimental.chat.system.transform — scan wiki frontmatter (readdir + first lines), inject topic list. Budget ~600-800 tokens. Inject once per session where possible. |
| 2 | Project inject   | Same hook. Match PluginInput.directory against Project pages' code_path (prefix match). Inject that overview. Deterministic — no rule, no pointer files. |
| 3 | memory_recall    | tool() — load ONE page by slug/path. Also list investigations by keyword/date. |
| 4 | memory_write     | tool() — validates frontmatter (type, description non-empty), enforces size cap (~150 lines), read-merge-REWRITE semantics, optional git commit. Rejects non-conforming writes with actionable error. |
| 5 | Janitor          | event: session.idle (+ debounce) — reads transcript delta via client.session.messages using per-session cursor (own state file), distills via session.promptAsync with cheap model into investigation notes / topic updates. Zero live-context cost. |
| 6 | Bootstrap        | tool: memory_bootstrap — batch-mode janitor over ENTIRE session history (user decision: full depth, all sessions, token spend accepted). Orchestrates out-of-band: iterate sessions, distill per session/batch via promptAsync, write incrementally. Live session sees progress summaries only. Data source: SDK client preferred (session list + messages); raw sqlite (~/.local/share/opencode/opencode.db — session/message/part tables, verified schema) as fallback. Sets code_path on project pages from session.directory column. |
| 7 | /memorize        | command — "capture this now" precision save.  |
| 8 | Compaction hook  | KEPT but demoted: single injection asking for a save if compaction ever fires. Last-ditch only. |

### Deleted from v1 (the entire blowup surface)

- 10K/60%/80% token nag injections (system.ts)
- Snapshot-append session files (storage.ts)
- memory_seed single-output project dump
- Global MEMORY.md chronological index format

## Save-Trigger Strategy (the "compaction never fires" problem)

1. PRIMARY: janitor on session.idle — harvests weeks-long sessions at natural
   pauses, out-of-band, cheap model.
   - NOTE: session.idle firing semantics (per-turn vs per-quiet-period) NOT yet
     verified — confirm during implementation; debounce handles either case.
2. /memorize for deliberate capture.
3. Compaction hook as free last-ditch (rare).
4. NO in-session periodic saving. That model is dead.

### Quality ladder (from friend #2's design)

Janitor/bootstrap write Investigations (low bar, factual, date-prefixed).
Promotion to Topic/runbook-style pages is deliberate (human-triggered via
/memorize or asking the model). Raw capture cheap; promoted knowledge curated.

## The One Rule (global instructions)

"Before claiming you don't know how to access/debug/configure something, call
memory_recall with keywords from the task." Small, single-purpose. (Pending
user yes/no — see open decisions.)

## USER DECISIONS (locked)

- Bootstrap: FULL DEPTH — every session in history. Token spend accepted.
- Git: optional, not a hard requirement.
- v1 data (~/.config/opencode/memory/MEMORY.md + {project}/.opencode/memory/):
  PURGE before testing — user wants to test v2 alone. Purge requires explicit
  confirmation step at execution time (data-deletion protocol).
- Acceptance test: install on a SEPARATE box with its own session history,
  empty wiki, run bootstrap, evaluate what it builds. Plugin must be fully
  self-contained: no hand-seeded content, no machine-specific assumptions.
- Storage model: topics + projects (wiki-style). No chronological session log.
- Recall: derived-TOC injection + on-demand recall tools.
- No sharing/team features. Obsidian purely optional as a viewer.

## OPEN DECISIONS — RESOLVED

1. Janitor/bootstrap model: SAME AS SESSION MODEL. Cost not a concern.
   No separate model config needed.
2. Janitor debounce: APPROVED — >=30 min since last harvest AND >=5K new
   transcript tokens. Tunable constants.
3. Recall rule: YES — but NOT via AGENTS.md/instructions. Injected by the
   plugin itself in the same system.transform block as the TOC. Fully
   self-contained; travels with the plugin.

## Self-Containment (user requirement)

- Plugin code has full fs access in-process — NO permission config needed for
  ~/wiki (v1 precedent: wrote to ~/.config/opencode/memory with zero config).
- memory_write does all wiki writes; model never needs edit/write perms there.
- Wiki dir auto-created on first use.
- Recall rule injected via system hook — no AGENTS.md edits ever.
- Second-box setup = ONE config line (plugin array entry) + "run bootstrap".
- UNVERIFIED: whether plugins can register slash commands. Verify at build.
  Fallback: /memorize is optional sugar (a command .md file), since saying
  "memorize this" already triggers the memory_write tool.

## Build Order

1. Storage/format lib: frontmatter parse/write, TOC derivation, size-cap
   validation, read-merge-rewrite. (Pure functions, no SDK.)
2. TOC + project-overview injection hook (kills the biggest rule dependency).
3. memory_recall + memory_write tools.
4. Janitor (idle event, cursor state, promptAsync distillation).
5. Bootstrap (batch janitor over history; SDK first, sqlite fallback).
6. /memorize command + compaction hook rewrite.
7. Rip out v1: nag hooks, seed tool, old storage format.
8. Fresh-box acceptance test.

## Verification Checkpoints

- After (2): start sessions in/out of a known project dir; confirm TOC +
  correct overview injected; measure injected token count (<1K).
- After (4): long fake session -> idle -> investigation file appears; live
  session context unchanged.
- After (5): bootstrap on THIS box's 214 sessions; spot-check pages against
  known history (UniFi API paths, DOCKER_API_VERSION=1.43 gotchas should
  surface as topics/investigations).
- Final: fresh box end-to-end.

## Known Risks

- experimental.* hooks + undocumented sqlite schema may change between
  opencode versions. SDK client preferred over raw DB wherever possible.
- session.idle semantics unverified (see above).
- client.session.list existence assumed for bootstrap via SDK — verify at
  build time; sqlite fallback exists (schema verified on this box).
- Bootstrap distillation quality over old/noisy sessions unknown — acceptance
  test on fresh box is the judge.

## Box-2 Acceptance Test — Findings So Far (2026-07-31)

Verified working: install runbook, TOC/empty-wiki response, bootstrap batches,
resume after user abort (state-file cursors), mutex compiled in, no duplicate
processing (bootstrapDone 68/68 unique mid-run).

Learned about the host: OpenCode executes queued tool calls SEQUENTIALLY —
the bootstrap mutex never fires in practice; parallel-call "silence" is the
model pre-queuing calls in one turn (cosmetic, reports exist as tool results).
User messages queue behind long tool calls (session turn serialization).

Observed defect: duplicate Project pages for one codebase —
projects/jira-remindme/ AND projects/jira-remindme-overview/, same code_path,
different slugs. Parallel-race hypothesis weakened by 0 duplicate processing;
prime suspect is distiller slug drift across batches.

## PENDING TUNING PASS — BLOCKED until box-2 11-question diagnostic returns

HOLD: no code changes until the diagnostic output is reviewed (user directive).

1. code_path as Project-page identity (distill.ts): incoming Project block
   whose code_path matches an existing page merges into THAT page regardless
   of model-chosen slug; derive project slug from basename(code_path).
   Makes project dupes structurally impossible.
2. Topic slug discipline: depending on diagnostic #4 (near-duplicate topic
   slugs), harden distiller prompt and/or add fuzzy slug match at write time.
3. One-time consolidation of existing duplicate pages on box 2
   (jira-remindme + whatever diagnostic #3 reveals).
4. Detached bootstrap (user-approved): memory_bootstrap returns immediately,
   batch runs fire-and-forget in the plugin (janitor pattern); add instant
   status probe (remaining count from state + live in-process counters) and
   a cancel argument checked between sessions. Tradeoffs accepted: no
   automatic end-of-batch chat report (poll instead); tool-call interrupt no
   longer stops the run; process exit mid-run relies on existing resumability.
5. Possibly raise/keep 5-min distill timeout + review FAILED sessions from
   diagnostic #8.

Diagnostic question list: 11 questions (projects inventory, jira-remindme full
contents, shared code_paths, topic near-dupes, git log/mtimes creation order,
state counts, dupe timing, FAILED/rejected lines, shortest+longest pages, TOC
description char total, subjective best/worst topics) — issued to user, awaiting
box-2 output.
