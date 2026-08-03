/**
 * Regression suite for opencode-memory.
 *
 * Run:  npm test
 *
 * Every case here exists because something broke or could break silently.
 * Fixtures marked [DR] come verbatim from the 2026-08-03 external defect
 * report — they are deliberately NOT authored by whoever wrote the code they
 * test, which is exactly why they caught what internal fixtures missed.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const wikiDir = mkdtempSync(join(tmpdir(), "memtest-"))
process.env["OPENCODE_WIKI_DIR"] = wikiDir
delete process.env["OPENCODE_WIKI_TOC_BUDGET"]
process.env["OPENCODE_WIKI_GIT"] = "0"

const dist = new URL("../dist/", import.meta.url).href
const { redactSecrets } = await import(dist + "lib/redact.js")
const wiki = await import(dist + "lib/wiki.js")

let pass = 0
let fail = 0
const failures = []

function check(name, condition, detail = "") {
  if (condition) {
    pass++
  } else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
  }
}

function section(title) {
  console.log(`\n── ${title}`)
}

/** Run a block; a throw is a test failure, never a crashed suite. */
function guard(name, fn) {
  try {
    return fn()
  } catch (err) {
    fail++
    failures.push(`${name} — threw: ${err instanceof Error ? err.message : err}`)
    return undefined
  }
}

// ───────────────────────────── redaction ─────────────────────────────
section("redaction: must PRESERVE identifiers (defect 4)")

const preserve = [
  ["[DR] secretsmanager ARN", "arn:aws:secretsmanager:us-east-1:123456789012:secret:dev/app/db-AbCdEf"],
  ["[DR] terraform var ref", "password = var.gitlabci_job_token"],
  ["[DR] terraform local ref", "password = local.db_password"],
  ["[DR] python os.environ", 'api_key = os.environ["SERVICE_API_KEY"]'],
  ["[DR] node process.env", "client_secret = process.env.CLIENT_SECRET"],
  ["[DR] CI token placeholder", "git clone https://gitlab-ci-token:${CI_JOB_TOKEN}@gitlab.example.com/x/y.git"],
  ["iam ARN", "arn:aws:iam::123456789012:role/CriblRole"],
  ["ssm path", "/prod/app/db/password"],
  ["account id", "AWS account 123456789012 in us-east-1"],
  ["bucket", "s3://indeed-detection-logs/cloudtrail/2026/08/"],
  ["env var name", "token is stored in $SLACK_BOT_TOKEN"],
  ["angle placeholder", "password: <your-password-here>"],
  ["shell placeholder", "api_key: ${API_KEY}"],
  ["version pin", "Set DOCKER_API_VERSION=1.43 or every docker command fails"],
  ["uuid", "Site UUID is 88f7af54-98f8-306a-a1c7-c9349722b1f6"],
  ["mac", "MAC 66:5f:b6:c9:09:a5 must be in the override rule"],
  ["vault ref", "password = vault.read('secret/data/db')"],
]
for (const [name, input] of preserve) {
  const r = redactSecrets(input)
  check(`preserve: ${name}`, r.text === input, `got: ${r.text}`)
}

section("redaction: must REDACT real credentials")

const redact = [
  ["[DR] literal password", "password = hunter2supersecret", "hunter2supersecret"],
  ["[DR] literal api key", 'api_key = "a1b2c3d4e5f6g7h8i9j0"', "a1b2c3d4e5f6g7h8i9j0"],
  ["[DR] url real password", "https://user:hunter2realpass@example.com/repo.git", "hunter2realpass"],
  ["[DR] aws access key", "AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
  ["aws secret key", "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
  ["github token", "token: ghp_16C7e42F292c6912E7710c838347Ae178B4a", "ghp_16C7e42F292c6912E7710c838347Ae178B4a"],
  ["slack token", "bot: xoxb-2334-4442-abcdefghijklm", "xoxb-2334-4442"],
  ["openai key", "OPENAI_API_KEY=sk-proj-abc123def456ghi789jkl012mno345", "sk-proj-abc123"],
  ["jwt", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl", "eyJzdWIiOiIxMjM0NTY3ODkw"],
  ["private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA"],
]
for (const [name, input, secret] of redact) {
  const r = redactSecrets(input)
  check(`redact: ${name}`, r.found.length > 0 && !r.text.includes(secret), `got: ${r.text}`)
}

section("redaction: no mangled output (defect 4b)")
const mangle = redactSecrets('api_key = os.environ["SERVICE_API_KEY"]')
check("no corrupted trailing fragment", !mangle.text.includes('[REDACTED:api_key]SERVICE_API_KEY"]'), mangle.text)

// ────────────────────── description handling (defect 1) ──────────────────────
section("description: over-long is truncated, page survives (defect 1)")

const longDesc = "A ".repeat(200)
const redacted =
  guard("long description must not throw", () =>
    wiki.writePage({
      relPath: "topics/long-desc.md",
      type: "Topic",
      title: "Long",
      description: longDesc,
      tags: [],
      timestamp: "",
      body: "important body content that must survive",
    })
  ) ?? []
const longPage = wiki.readPage("topics/long-desc.md")
check("page written despite long description", longPage != null)
check("body preserved", longPage?.body.includes("important body content"))
check("description clipped to cap", (longPage?.description.length ?? 999) <= wiki.MAX_DESCRIPTION_CHARS)
check("truncation reported", redacted.includes("description-truncated"), JSON.stringify(redacted))

section("validation: hard rejects still reject")
for (const [name, page] of [
  ["empty description", { relPath: "topics/x.md", type: "Topic", title: "t", description: "", tags: [], timestamp: "", body: "b" }],
  ["missing code_path", { relPath: "projects/x/overview.md", type: "Project", title: "t", description: "d", tags: [], timestamp: "", body: "b" }],
  ["over-long body", { relPath: "topics/y.md", type: "Topic", title: "t", description: "d", tags: [], timestamp: "", body: Array(200).fill("l").join("\n") }],
]) {
  let threw = false
  try {
    wiki.writePage(page)
  } catch {
    threw = true
  }
  check(`reject: ${name}`, threw)
}

// ────────────────────── investigation dates (defect 2) ──────────────────────
section("investigation slugs: dates do not compound (defect 2)")

check("plain slug gets a date", /^investigations\/\d{4}-\d{2}-\d{2}-foo\.md$/.test(wiki.pathFor("Investigation", "foo")))
check(
  "dated slug keeps its own date, not today",
  wiki.pathFor("Investigation", "2026-05-04-foo") === join("investigations", "2026-05-04-foo.md"),
  wiki.pathFor("Investigation", "2026-05-04-foo")
)
check(
  "[DR] compounded slug collapses",
  wiki.pathFor("Investigation", "2026-08-03-2026-08-03-2026-05-04-ms-minutes") ===
    join("investigations", "2026-08-03-ms-minutes.md"),
  wiki.pathFor("Investigation", "2026-08-03-2026-08-03-2026-05-04-ms-minutes")
)
check("splitLeadingDate strips all prefixes", guard("splitLeadingDate", () => wiki.splitLeadingDate?.("2026-08-03-2026-05-04-foo").slug) === "foo")
check("date-only slug is not destroyed", guard("splitLeadingDate date-only", () => wiki.splitLeadingDate?.("2026-08-03").slug) === "2026-08-03")

section("investigation merge: matches across days (defect 2b)")
guard("write dated investigation", () =>
  wiki.writePage({
    relPath: "investigations/2026-05-04-sqs-drops.md",
    type: "Investigation",
    title: "SQS drops",
    description: "d",
    tags: [],
    timestamp: "",
    body: "original",
  })
)
const found = guard("findInvestigationBySlug exists", () => wiki.findInvestigationBySlug?.("2026-08-03-sqs-drops"))
check("finds earlier investigation by bare slug", found?.relPath === "investigations/2026-05-04-sqs-drops.md", String(found?.relPath))
check("idempotent: same slug twice resolves to one path", guard("bare slug lookup", () => wiki.findInvestigationBySlug?.("sqs-drops")) != null)

// ───────────────────────── frontmatter safety ─────────────────────────
section("frontmatter: hostile values stay parseable (unknown-unknown)")

for (const [name, title, description] of [
  ["newline in description", "T", "line one\nline two"],
  ["quotes", 'He said "hi"', 'desc with "quotes"'],
  ["colons", "a: b: c", "key: value: another"],
  ["brackets in tags", "T", "d"],
  ["tabs", "T\there", "d\tthere"],
]) {
  const rel = `topics/hostile-${name.replace(/\W+/g, "-")}.md`
  let ok = true
  try {
    wiki.writePage({ relPath: rel, type: "Topic", title, description, tags: ["a,b", "c]d"], timestamp: "", body: "body" })
  } catch {
    ok = false
  }
  check(`parses back: ${name}`, ok && wiki.readPage(rel) != null)
}

// ───────────────────────── path traversal ─────────────────────────
section("path traversal is refused (unknown-unknown)")

check("readPage refuses ../", guard("readPage traversal", () => wiki.readPage("../../../etc/passwd")) == null)
check("resolveWikiPath refuses escape", guard("resolveWikiPath escape", () => wiki.resolveWikiPath?.("../../evil.md")) == null)
check("resolveWikiPath allows normal", guard("resolveWikiPath normal", () => wiki.resolveWikiPath?.("topics/ok.md")) != null)
let traversalThrew = false
try {
  wiki.writePage({ relPath: "../../evil.md", type: "Topic", title: "t", description: "d", tags: [], timestamp: "", body: "b" })
} catch {
  traversalThrew = true
}
check("writePage refuses escape", traversalThrew)

// ───────────────────────── revision / CAS ─────────────────────────
section("page revision changes on write (concurrency guard)")

guard("write rev v1", () => wiki.writePage({ relPath: "topics/rev.md", type: "Topic", title: "R", description: "d", tags: [], timestamp: "", body: "v1" }))
const rev1 = guard("revision v1", () => wiki.pageRevision?.("topics/rev.md"))
guard("write rev v2", () => wiki.writePage({ relPath: "topics/rev.md", type: "Topic", title: "R", description: "d", tags: [], timestamp: "", body: "v2" }))
const rev2 = guard("revision v2", () => wiki.pageRevision?.("topics/rev.md"))
check("revision differs after edit", rev1 != null && rev2 != null && rev1 !== rev2, `${rev1} vs ${rev2}`)
check("missing page has sentinel revision", guard("revision missing", () => wiki.pageRevision?.("topics/nope.md")) === "none")

// ───────────────────────── TOC behaviour ─────────────────────────
section("TOC: budget, fairness, truncation reporting")

check("1M context ≈ 325k chars", guard("budget 1M", () => wiki.tocBudgetFor?.(1_000_000)) === 325_000)
check("200K context ≈ 65k chars", guard("budget 200K", () => wiki.tocBudgetFor?.(200_000)) === 65_000)
check("unknown context falls back", guard("budget 0", () => wiki.tocBudgetFor?.(0)) === wiki.TOC_CHAR_BUDGET)
check("tiny context respects floor", (guard("budget tiny", () => wiki.tocBudgetFor?.(100)) ?? 0) >= 8_000)

for (let i = 0; i < 300; i++) {
  guard("bulk write", () =>
    wiki.writePage({ relPath: `topics/bulk-${String(i).padStart(3, "0")}.md`, type: "Topic", title: "t", description: "y".repeat(150), tags: [], timestamp: "", body: "b" })
  )
}
guard("solo project write", () =>
  wiki.writePage({ relPath: "projects/solo/overview.md", type: "Project", title: "p", description: "d", tags: [], timestamp: "", codePath: "/code/solo", body: "b" })
)
const small = wiki.deriveTOC(undefined, 12_000)
check("unbalanced sections: small section still present", /^PROJECTS/m.test(small))
check("truncation is announced", small.includes("omitted"), small.slice(-120))
const big = wiki.deriveTOC(undefined, 325_000)
check("large budget omits nothing", wiki.tocTruncationCount(undefined, 325_000) === 0)
check("large budget lists more than small", big.length > small.length)

section("body caps: lines AND chars")
let charCapThrew = false
try {
  wiki.writePage({
    relPath: "topics/huge.md",
    type: "Topic",
    title: "t",
    description: "d",
    tags: [],
    timestamp: "",
    body: Array(10).fill("x".repeat(5_000)).join("\n"), // 10 lines, 50k chars
  })
} catch {
  charCapThrew = true
}
check("rejects huge body even within the line cap", charCapThrew)

// ───────────────────────── duplicate detection ─────────────────────────
section("duplicate detection")

wiki.writePage({ relPath: "projects/dupe-a/overview.md", type: "Project", title: "A", description: "d", tags: [], timestamp: "", codePath: "/code/same", body: "b" })
wiki.writePage({ relPath: "projects/dupe-b/overview.md", type: "Project", title: "B", description: "d", tags: [], timestamp: "", codePath: "/code/same/", body: "b" })
const dupes = wiki.findDuplicates()
check("detects shared code_path (trailing slash tolerant)", dupes.some((g) => g.reason.includes("code_path")))
check("deletePage removes a page", wiki.deletePage("projects/dupe-b/overview.md") === true)
check("no code_path dupes remain", !wiki.findDuplicates().some((g) => g.reason.includes("code_path")))

// ───────────────────────── summary ─────────────────────────
rmSync(wikiDir, { recursive: true, force: true })

console.log(`\n${"─".repeat(60)}`)
console.log(`${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFAILURES:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log("all green")
