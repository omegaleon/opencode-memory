# RESEARCH — Prior art in LLM/agent persistent memory (2026-08-02)

Research only. No code changes. Purpose: find concrete, stealable mechanisms for
opencode-memory v2 (plain-markdown wiki, derived TOC injection, out-of-band janitor,
full-history bootstrap) that add effectiveness WITHOUT adding bloat or heavy deps.

Every claim below is from official docs or source, with URLs.

---

## 1. mem0

Docs: https://docs.mem0.ai/core-concepts/how-it-works ·
https://docs.mem0.ai/core-concepts/memory-operations/add ·
https://docs.mem0.ai/core-concepts/memory-evaluation ·
https://docs.mem0.ai/platform/features/memory-decay ·
https://docs.mem0.ai/cookbooks/essentials/controlling-memory-ingestion
Source: https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py

**Storage.** Not files. Three stores: SQL (facts + metadata = source of truth, plus an
ADD-event history log), vector DB (embeddings), entity/graph store (entities +
linked_memory_ids). A "memory" is a short self-contained sentence (v3 prompt targets
15–80 words, up to 100), scoped by `user_id` / `agent_id` / `app_id` / `run_id` +
arbitrary metadata. Layers: conversation → session → user → org.

**Capture.** Automatic, background, out-of-band ("conversation enters the pipeline
asynchronously, after the agent responds"). Six stages: store → **context lookup**
(fetch related existing memories first) → distill (single-pass LLM) → hash dedup +
embed → entity linking → a **separate temporal-reasoning pass** that tags each memory
with when the event occurred, whether it's ongoing/completed, timing precision, and a
memory type (event, state, plan, preference, relationship, absence). That temporal pass
is independent and can run async so writes stay fast.

**Retrieval.** Never always-injected. App calls `search()` before the model call.
Multi-signal fusion: semantic (vectors) + keyword (BM25 with verb lemmatization) +
entity boost + temporal-intent score. `top_k=200` default budget, ~6.7–7.0K tokens/query.

**Dedup / conflict — two distinct generations, both instructive:**

- *OSS v2, `DEFAULT_UPDATE_MEMORY_PROMPT`*: feed the LLM the existing memories **with
  IDs** plus the newly extracted facts; it returns one record per memory with
  `event: ADD | UPDATE | DELETE | NONE`, reusing existing IDs and echoing `old_memory`
  on UPDATE. Rules: same fact with more detail → UPDATE (keep the ID); semantically
  equivalent → NONE; contradiction → DELETE.
- *v3 platform, `ADDITIVE_EXTRACTION_PROMPT`*: **ADD-only**, nothing is ever
  overwritten. Dedup is achieved by injecting into the extraction prompt: a narrative
  profile summary, the last ~20 "Recently Extracted Memories", and the relevant
  "Existing Memories" as `[{"id": uuid, "text": ...}]`. Notable explicit rules:
  - "An existing memory about an entity does NOT mean all information about that entity
    has been captured" (guards against under-capture).
  - **No Detail Contamination from Context** — do not import details from existing
    memories into a new extraction unless the new message mentions them.
  - **No Meta-Extraction** — record the *content* shared, not "user asked for X".
  - **No Echo Extraction** — don't re-extract the assistant restating the user.
  - `linked_memory_ids` for same-entity / updated-preference / continuation /
    contradiction relationships.
  - Ground every relative time reference to an explicit `Observation Date`; never
    convert absolute → vague ("18 days" stays "18 days").

  Docs are candid about the cost: knowledge-update is their weakest LongMemEval
  category (93.6) precisely "because older facts are preserved rather than overwritten".

**Pruning / decay.** Two mechanisms: per-memory `expiration_date` (hidden from search
after that date, still fetchable by ID), and **Memory Decay** (opt-in per project,
search-time only). Decay is a *soft ranking bias, never a filter*: last-access recency +
frequency (capped at the last 20 touches) produce a 0.3×–1.5× multiplier on the score;
the candidate pool over-fetches `top_k × 3` (floor 50) so reordering has room.
Roadmap: category-aware weighting, per-project auto-tuning.

**Redaction.** No programmatic redaction. Done by prompt: project-level or per-call
`custom_instructions` ("NEVER STORE: SSNs, insurance policy numbers, credit cards…"),
plus confidence gating in the same prompt. Docs warn: "Avoid storing secrets, raw
credentials, or unredacted sensitive data. Mem0 is designed to retrieve stored context."

**Benchmarks** (managed platform, top_200 budget, single-pass retrieval):

```
| Benchmark    | Score | Mean tokens/query |
|--------------|-------|-------------------|
| LoCoMo       | 92.5  | 6,956             |
| LongMemEval  | 94.4  | 6,787             |
| BEAM (1M)    | 64.1  | 6,719             |
| BEAM (10M)   | 48.6  | 6,914             |
```

Weakest BEAM categories at 10M: temporal_reasoning 16.3, event_ordering 20.2,
multi_session_reasoning 26.1, contradiction_resolution 32.5.

The framing worth stealing: **token efficiency is a first-class metric.** "A system that
scores 95% using 25K tokens per query isn't comparable to one scoring 90% using 7K."
Harness: https://github.com/mem0ai/memory-benchmarks

---

## 2. Letta (MemGPT lineage)

Docs: https://docs.letta.com/concepts/memfs/index.md ·
https://docs.letta.com/configuration/memory/index.md ·
https://github.com/letta-ai/context-constitution

**Storage.** **MemFS** — a *git-versioned* filesystem of markdown files with YAML
frontmatter (`description:` is the required field). Structure:

```
$MEMORY_DIR/
├── system/        # loaded into the system prompt EVERY turn (identity, prefs, rules)
├── reference/     # discoverable via the memory tree; contents loaded only when relevant
└── skills/        # agent-owned skills, versioned with memory
```

Every edit is a git commit → version history, conflict resolution, and a clean boundary
between saved memory and uncommitted changes. Memory subagents use **git worktrees** so
background reorganization doesn't block the main agent.

**Capture.** Three paths: (a) the agent self-edits when it learns something durable;
(b) `/remember <lesson>` — explicit, agent decides *where* it belongs; (c) **dreaming** —
background subagents review recent conversations, consolidate lessons, and update memory
without interrupting active work. Dreaming is configurable to fire after N user messages
or on compaction. `/init` bootstraps memory by inspecting the repo and reviewing prior
coding sessions with subagents.

**Retrieval.** `system/` always injected. Everything else: plain file search + read
tools. **MemFS ships no vector index by default**; keyword/semantic/hybrid search is an
optional mod (`@letta-ai/memfs-search`, semantic requires an external indexer).

**Dedup / conflict.** `/doctor` audits "placement, duplication, and system-prompt token
usage". "Reorganize memory" backs up the repo first, then splits large files, merges
duplicates, restructures the hierarchy.

**Pruning / staleness.** Governed by the Context Constitution's *Efficiency* principle:
evict stale content; **place frequently-updated memories near the END of the system
prompt to minimize KV-cache invalidation**; avoid redundancy across blocks; and — the
sharpest idea — **do not store what can be re-derived**:

> "On March 3rd, Sarah and I worked on documentation" is information that could be
> retrieved by simply searching for messages exchanged on March 3rd… "March 3rd 2-3pm
> PST contains reference interactions for debugging crashes in production" contributes
> to the agent's context index.

Counterweight: explicit warning that over-aggressive pruning destroys identity/continuity;
only externalize context once you're confident the index will retrieve it reliably.
Also: *Progressive Disclosure* — keep compact indexes in context, load full content on
demand, "place the description of a file in metadata frontmatter so the purpose of the
file can be understood without reading the entire file."

**Redaction.** Not addressed for memory. A separate `Secrets` feature stores API keys for
shell use.

---

## 3. basic-memory (basicmachines-co/basic-memory)

Docs: https://docs.basicmemory.com/concepts/knowledge-format ·
https://docs.basicmemory.com/concepts/vs-built-in-memory ·
https://github.com/basicmachines-co/basic-memory ·
https://github.com/basicmachines-co/basic-memory/blob/main/plugins/claude-code/DESIGN.md

**Storage.** Plain markdown, Obsidian-compatible, plus a local SQLite index (Postgres
optional). Grammar is tiny: an **Entity** (file) has **Observations** and **Relations**.

```markdown
---
title: Authentication Design
type: note
tags: [auth, security, backend]
permalink: authentication-design
---
## Observations
- [decision] Using JWT tokens for stateless authentication #security
- [constraint] Tokens expire after 15 minutes

## Relations
- implements [[API Security Requirements]]
- depends_on [[User Database Schema]]
```

Observations are indexed **individually**, so search returns the specific fact rather than
the whole doc. Permalinks are stable across renames/moves. Frontmatter is open —
any field is searchable via metadata filters.

**Capture.** Primarily *deliberate* ("make a note about X" → `write_note`). The Claude
Code plugin adds automatic hooks:
- **SessionStart hook** → parallel structured queries (active tasks, open decisions,
  recent sessions, recent activity) rendered as a short brief + a trailing **recall
  prompt** ("without it, agents ignore injected context"). Hard 10,000-char cap.
- **PreCompact hook** → writes a session checkpoint note. Verified: PreCompact blocks
  synchronously with a **600-second default timeout**, so a full LLM summarization pass
  fits comfortably — they upgraded the default from extractive to summarized because of it.

**Retrieval.** On-demand MCP tools only: `search_notes` (text / semantic / hybrid, plus
`metadata_filters` with `$in`, `$gt/$lt`, `$between`, `after_date`), `recent_activity`,
`build_context` (traverses `memory://` URLs through the relation graph). **Semantic vector
search is opt-in and off by default**; cross-encoder reranking is also off by default
(latency + first-run model download). Every MCP tool carries behavior annotations
(readOnly / destructive / idempotent / openWorld) so agents pick correctly without
burning context on trial-and-error.

**Dedup / conflict.** No LLM-arbitrated merge. Instead: `edit_note` append/prepend,
`write_note` guards against accidental overwrite, `basic-memory doctor` for file↔DB
consistency, and a **schema system** (`schema_infer`, `schema_validate`, `schema_diff`)
with `validation: warn` — *never* strict, because "the user's flow is sacred; the schema
is a helper, not a gate." The design doc is explicit about why typed frontmatter matters:

> A decision captured without `type: decision` is invisible to the next session's
> structured recall… This is the difference between a recall brief that's *precise* and
> one that's *vibes*.

**Pruning.** None automatic. Bounded by `recallTimeframe` (default 3d) and per-section
item caps in the brief; prefers permalinks over content previews to stay under the cap.

**Redaction.** Not addressed.

**Positioning worth noting:** they explicitly do NOT try to replace built-in memory.
Built-in memory = "how you like to work" (short-term cache); basic-memory = "what you know
and what you've decided" (long-term store).

---

## 4. Claude Code memory (CLAUDE.md, auto memory, /memory, memory tool)

Docs: https://docs.claude.com/en/docs/claude-code/memory ·
https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool

**Two systems, deliberately split:**

```
|              | CLAUDE.md              | Auto memory                          |
|--------------|------------------------|--------------------------------------|
| Who writes   | You                    | Claude                               |
| Contains     | Instructions, rules    | Learnings, patterns                  |
| Scope        | Project / user / org   | Per repository (shared by worktrees) |
| Loaded into  | Every session (in full)| Every session (first 200 lines/25KB) |
```

**Storage.** Auto memory: `~/.claude/projects/<project>/memory/` containing a
`MEMORY.md` index plus topic files (`debugging.md`, `api-conventions.md`, …). Machine-local.
`<project>` derives from the git repo, so all worktrees share one directory.

**Capture.** Claude writes notes itself as it works, based on corrections and preferences.
"Claude doesn't save something every session. It decides what's worth remembering based
on whether the information would be useful in a future conversation." Also on request
("remember that the API tests require a local Redis instance").

**Retrieval.** MEMORY.md index injected every session, truncated at 200 lines / 25 KB.
Topic files are NOT loaded at startup — read on demand with normal file tools. Path-scoped
`.claude/rules/*.md` (glob `paths:` frontmatter) load only when Claude touches matching
files. Project-root CLAUDE.md is re-read from disk and re-injected after `/compact`.

**Machinery worth copying (this is the good part):**
- After Claude writes MEMORY.md, Claude Code **measures the file against the read limit**.
  Near the limit → a reminder to shorten (one line per entry, move detail to topic files,
  merge or drop stale entries). Over the limit → **an error telling Claude to rewrite the
  index**, "because everything past the limit is dropped on the next load." Enforcement in
  code, not prose.
- YAML frontmatter and block-level HTML comments are **stripped before measuring and
  before injection** — so metadata and human maintainer notes cost zero context.
- When Claude writes a memory file that already has frontmatter, Claude Code stamps a
  `modified` ISO-8601 field automatically. "The timestamp shows how current the fact is,
  both to you and to Claude when it reads the memory back."
- `/doctor` proposes trims for CLAUDE.md: **cuts content derivable from the codebase**
  (directory layouts, dependency lists, architecture overviews) and **keeps pitfalls,
  rationale, and conventions that differ from tool defaults.**
- Size guidance: target <200 lines. "Longer files consume more context and reduce
  adherence." Contradictory rules → "Claude may pick one arbitrarily."

**Memory tool (API).** Client-side file ops under `/memories` (view/create/str_replace/
insert/delete/rename). The API auto-injects this system prompt:

> IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE… ASSUME
> INTERRUPTION: Your context window might be reset at any moment, so you risk losing any
> progress that is not recorded in your memory directory.

Security guidance (explicitly the implementer's job): cap file sizes, cap `view` output and
page with `view_range`, **periodically delete memory files not accessed in a long time**,
enforce path-traversal protection, and — on secrets — "Claude usually refuses to write
sensitive information to memory files. **For stronger guarantees, add validation that
strips sensitive data before your handler writes the file.**"

---

## 5. Published context-engineering / agent-memory guidance

### Anthropic — Effective context engineering for AI agents (2025-09-29)
https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

- Context is a finite resource with diminishing returns ("context rot"); goal is "the
  smallest possible set of high-signal tokens."
- **Just-in-time context**: keep lightweight identifiers (file paths, queries, links) and
  load data at runtime, rather than pre-processing everything. **Metadata is signal**:
  "Folder hierarchies, naming conventions, and timestamps all provide important signals…
  file sizes suggest complexity; naming conventions hint at purpose; timestamps can be a
  proxy for relevance."
- Claude Code itself is the **hybrid**: CLAUDE.md dropped in up front, glob/grep
  just-in-time — "effectively bypassing the issues of stale indexing."
- Compaction prompt tuning: "**Start by maximizing recall**… then iterate to improve
  precision by eliminating superfluous content."
- Sub-agent pattern: a subagent may burn tens of thousands of tokens exploring and return
  only a **1,000–2,000 token distilled summary**.

### Anthropic — Effective harnesses for long-running agents (2025-11-26)
https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

- **Initializer agent vs worker agent**: a different prompt for the very first context
  window, whose only job is to build the scaffolding future sessions read.
- Artifacts: a `claude-progress.txt` log, git history, an `init.sh`, and a feature list.
- **Feature list is JSON, not markdown, on purpose**: "the model is less likely to
  inappropriately change or overwrite JSON files compared to Markdown files."
- Session-start ritual: `pwd` → read progress file → read git log → read feature list →
  run a smoke test *before* starting new work.
- Failure modes named: agent one-shots and runs out of context mid-feature; a later agent
  "sees that progress had been made, and declares the job done"; features marked complete
  without end-to-end verification.

### OpenAI — Context engineering / session memory cookbook
https://cookbook.openai.com/examples/agents_sdk/session_memory

Trimming vs summarizing tradeoffs, and a summarization-prompt design checklist that is
directly applicable to a distiller prompt:
- **Contradiction check** before writing (compare claims against instructions/tool logs).
- **Temporal ordering** — sort by time, most recent wins, keep timestamps.
- **Hallucination control** — "if any fact is uncertain/not stated, mark it as
  UNVERIFIED rather than guessing."
- **"Superseded:"** prefix for replaced facts; omit details unless critical.
- Chunk into fixed headings, not paragraphs. Verbs first. Quote error strings and codes
  exactly. Hard word cap.
- Evals: LLM-as-judge on summary quality, transcript replay for next-turn accuracy,
  error-regression tracking, token-pressure checks.

---

## 6. Other markdown-wiki "second brain" projects

**Cline Memory Bank** — https://docs.cline.bot/prompting/cline-memory-bank
Fixed 6-file hierarchy (`projectbrief.md`, `productContext.md`, `activeContext.md`,
`systemPatterns.md`, `techContext.md`, `progress.md`) in `memory-bank/`. 100% prompt, zero
machinery: "I MUST read ALL memory bank files at the start of EVERY task — this is not
optional", plus an "update memory bank" command that reviews ALL files. Capture is manual,
retrieval is read-everything. **This is exactly the v1 failure mode with a different coat
of paint** — unbounded always-loaded context, no dedup, no staleness handling. Useful only
as a warning and for its file taxonomy.

**mem0's OpenCode plugin** — https://docs.mem0.ai/integrations/opencode
Directly comparable harness. Notable: **auto-dream** (consolidation that merges duplicates,
drops stale/sensitive entries, rewrites vague ones) gated by **all three** of ≥24h since
last run, ≥5 sessions since, ≥20 memories stored, with a **filesystem lock**
(`~/.mem0/mem0-dream.lock`) so two sessions can't consolidate concurrently, plus a
`/mem0-status` command that reports exact gate progress (`sessions 2/5, memories 3/20`).
Also uses `tool.execute.before` to **block MEMORY.md writes and steer them to the memory
tool**, and scopes memories by git remote (`owner-repo`) with project/session/global scopes.

**Letta MemFS** and **basic-memory** — covered above; these are the two serious
markdown-wiki implementations.

---

## TOP IDEAS WORTH STEALING

Ordered by (value ÷ effort). All are prompt or small-code changes; none add a dependency.

### 1. Credential redaction at the single write choke point — CODE, not prompt
Nobody in this space does this properly. mem0 handles it with a prompt instruction;
Anthropic explicitly punts to the implementer ("add validation that strips sensitive data
**before your handler writes the file**"). We have a genuine structural advantage: every
wiki write funnels through `validatePage`/`memory_write`. A regex denylist (`AKIA[0-9A-Z]{16}`,
`sk-…`, `ghp_`/`gho_`, `xox[baprs]-`, `-----BEGIN .* PRIVATE KEY-----`, `Authorization:
Bearer …`, `password=`/`token=`/`secret=` assignments with high-entropy values) that masks
or rejects is ~40 lines. Distilling full transcripts into a durable, greppable `~/wiki` is
*precisely* how credentials leak into a permanent artifact. Highest value-per-line here.

### 2. Give the distiller an explicit `NONE` verdict
mem0's `DEFAULT_UPDATE_MEMORY_PROMPT` requires a per-item `event: ADD|UPDATE|DELETE|NONE`.
The valuable one for us is **NONE**: an explicit, cheap "nothing new — do not rewrite this
page" outcome. Our current protocol emits pages, so every idle harvest is pressure to
rewrite, which is how slug/content drift and paraphrase churn happen. A NONE verdict also
makes the janitor cheap on quiet sessions and makes "did this harvest change anything?"
observable in state.

### 3. Inject the candidate set into the distillation prompt (dedup before generation)
mem0's pipeline does a **context lookup before extraction** and passes the relevant
existing memories *with their IDs* into the prompt. We already learned this lesson
reactively (jira-remindme dupe → `code_path` as project identity). Do it proactively:
before distilling, hand the child session the candidate page list (slug + path +
description) for the topics the transcript touches, and require it to either reuse an
existing slug or explicitly justify a new one. Pure prompt + a `listPages()` call.

### 4. Three anti-rot extraction rules, near-verbatim from mem0's v3 prompt
Non-obvious, cheap, and each maps to a failure mode we can already see in the corpus:
- **"An existing page about X does NOT mean everything about X is captured"** — prevents
  the distiller from skipping a genuinely new fact because the topic page exists.
- **"No Detail Contamination"** — do not import details from the existing page into the
  new extraction unless the transcript mentions them. This is the hallucinated-merge guard
  for read-merge-rewrite.
- **"No Meta-Extraction"** — record the *content*, not "the user asked about X" /
  "the assistant investigated Y". Our `investigations/` pages are exactly where this rots.

### 5. Frontmatter as a filterable index, and `memory_recall` filters to match
basic-memory's single biggest leverage point: typed frontmatter turns recall from "vibes"
into deterministic set queries. We already have `type`/`tags`/`code_path`. Add `status`
(`current` | `superseded` | `draft`) and `updated`, then give `memory_recall` filters
(`type`, `tag`, `updated_since`, `code_path`). No index needed — we already read
frontmatter to derive the TOC.

### 6. Auto-stamp `updated:` on every write, and show age in the TOC
Claude Code stamps `modified` automatically; Anthropic's context-engineering post calls
timestamps "a proxy for relevance"; OpenAI's summarization checklist says most-recent-wins.
Stamp `updated` in `memory_write` (not the model's job), and render age in the TOC entry
for anything older than N months. Zero recall cost, real staleness signal, and it gives the
consolidation job something to sort on.

### 7. When the TOC exceeds budget, escalate — never silently truncate
We already shipped this bug once (12,598 chars of descriptions against a 3,200 budget →
~75% of the wiki invisible). Claude Code's fix is the right shape: after every write,
**measure and return an actionable error/reminder** ("keep one line per entry, move detail
into topic files, merge or drop stale entries"); over the limit is an error "because
everything past the limit is dropped on the next load." For us: when the derived TOC would
exceed budget, (a) never drop silently — log/flag it, and (b) enqueue a consolidation task
for the janitor. Enforcement in code, not convention.

### 8. A separate, rarer consolidation ("doctor"/"dream") job with hard gates + lock
Letta's `/doctor` audits placement, duplication, and prompt token usage; its reorganize
flow backs up first, then splits/merges/restructures. mem0's auto-dream merges duplicates,
drops stale entries, rewrites vague ones — gated on **all** of ≥24h AND ≥5 sessions AND
≥20 memories, with a filesystem lock. We already have harvest debounce and a
bootstrap-running guard; add a distinct consolidation job with its own (much rarer) gates
that merges near-duplicate pages, promotes recurring investigations into a topic, and marks
stale pages. Reuses the existing child-session machinery — no new surface area.

### 9. Store pointers, not transcripts (`source_sessions` in frontmatter)
The sharpest single line in the Letta constitution: recording "on March 3rd we worked on
docs" is waste because it's re-derivable from the message DB; "March 3rd 2-3pm contains
reference interactions for debugging crashes in production" is an index entry. Our
`investigations/` pages should be either a durable fact or a *pointer with a handle*.
Bootstrap already has session IDs — put them in frontmatter (`source_sessions: [...]`)
so a page can always be traced back, and instruct the distiller to prefer a pointer over a
narrative retelling.

### 10. Distiller hygiene rules from OpenAI's summarization checklist
Prompt-only, directly attacks the "confidently wrong wiki page" failure:
contradiction-check against the existing page before rewriting; most-recent-wins with dates
preserved; mark unverified claims **UNVERIFIED** rather than asserting them; prefix
replaced facts with **"Superseded:"** instead of deleting them outright (this is our answer
to mem0's ADD-only-vs-overwrite tension, at page granularity); quote error strings, codes,
paths, and version numbers **verbatim**; never generalize a specific (`DOCKER_API_VERSION=1.43`
must not become "a specific Docker API version").

### Bonus (cheap, lower value): access-based soft ordering
mem0's decay: last-access recency + frequency (last 20 touches) → 0.3×–1.5× multiplier at
search time, **never a filter**. Our zero-dependency version: `memory_recall` bumps a
counter + `last_read` in `.memory-state.json`; when the TOC is over budget, use that to
order (not to drop). Only worth doing after #7 exists.

### Also worth verifying (not an idea, a question)
basic-memory verified Claude Code's `PreCompact` hook blocks synchronously with a
**600-second** default timeout — enough for a full LLM summarization pass, which made them
upgrade their compaction capture from extractive to summarized. Our
`experimental.session.compacting` hook is currently a demoted last-ditch nag. Worth
measuring OpenCode's actual timeout: if it's generous, compaction could trigger a real
out-of-band distillation instead of a prompt.

---

## EXPLICITLY NOT WORTH IT

**Vector DB / embeddings.** mem0 needs one because it stores thousands of atomic sentences
with no human-readable index. We store ~90 pages, each with a one-line `description`, and
the derived TOC *is* the index — it fits in ~3.5K tokens. Corroborating evidence: Letta's
MemFS ships **no vector index by default**, and basic-memory ships semantic search **off by
default** and reranking **off by default** (latency + model download). Revisit only if the
wiki passes ~500 pages or the TOC stops fitting the budget — and even then, try
description-only keyword matching first.

**Knowledge graph / typed relations / wikilinks (`- implements [[X]]`).** basic-memory's
graph only pays off because they built `build_context`, permalink resolution, an entity
index, and graph traversal on top of it. Our recall is "load the page." Grep + the TOC gets
most of the value. If we ever want 5% of it, a plain `related: [slug, slug]` frontmatter
field costs nothing — but do not build link resolution, orphan detection, or traversal.

**mem0's atomic-fact model and ADD-only architecture.** ADD-only is exactly why their
weakest LongMemEval category is knowledge update (93.6) and BEAM contradiction_resolution
is 35.7 / 32.5. Read-merge-rewrite of whole pages is *better* for durable engineering
knowledge. Steal their prompts, not their architecture.

**Multi-signal retrieval fusion (BM25 + entity boost + temporal scoring).** That solves
ranking 200 candidates. We return one to three whole pages. Not applicable at our scale,
and it drags in lemmatization and an entity store.

**Cline's Memory Bank model** (fixed 6 files, "read ALL files at the start of EVERY task").
This is v1's context blowup restated. Our derived TOC already strictly dominates it. The
file taxonomy is mildly interesting for what a project overview should contain
(brief / context / active / patterns / tech / progress), nothing more.

**Letta's self-editing system prompt, persona, and identity layer.** Genuinely interesting
research, entirely orthogonal to a knowledge wiki, and directly antagonistic to our "tiny
always-loaded surface" principle. Skip.

**Sub-agent fan-out / parallel bootstrap.** Already ruled out for merge-race reasons.
Independent corroboration: mem0's own consolidation uses a filesystem lock for exactly this,
and Letta needs git worktrees to let memory subagents run concurrently. Sequential +
resumable is the right call.

**A schema system (`schema_infer` / `schema_validate` / `schema_diff`).** Three tools and a
picoschema parser to enforce what our single `validatePage` already enforces across four
fields. Over-engineering at 90 pages. Steal only the *insight* (typed frontmatter →
deterministic recall, idea #5), not the machinery.

**Hard TTL / `expiration_date` on pages.** Engineering knowledge doesn't expire on a
schedule — it gets *superseded*. `updated` + a "Superseded:" convention + the consolidation
job is the correct mechanism. Auto-deleting durable pages risks silent knowledge loss and
carries a real data-deletion blast radius.

**Git as a hard requirement.** Letta requires it (every edit is a commit). We already have
it as an optional no-op-if-absent. Optional is correct: mandatory git means mandatory
conflict handling, worktrees for the janitor, and a failure mode on every write.

---

## WHAT THE RESEARCH CONFIRMS ABOUT THE CURRENT DESIGN

- **Derived TOC + on-demand recall** is exactly Anthropic's "just-in-time context" and
  Letta's "progressive disclosure." Letta independently arrived at "place the description
  in metadata frontmatter so the purpose of the file can be understood without reading it"
  — that is our `description:` field, verbatim.
- **Out-of-band janitor** is Letta's "dreaming" and mem0's async post-response extraction.
  Both major systems capture *after* the agent responds, never in the live turn.
- **Killing the in-session save nags** matches Anthropic's attention-budget argument and
  basic-memory's own decision to drop per-turn capture ("auto-memory already does the
  per-turn working summary; doubling it creates noise without value").
- **A recall rule shipped in the injection** is corroborated by basic-memory's finding:
  "The trailing instruction block is **the recall prompt** — without it, agents ignore
  injected context."
- **Read-merge-rewrite with a hard size cap** is the same lever Claude Code pulls on
  MEMORY.md, and their enforcement (measure after write, error with instructions) is
  strictly better than ours today.
