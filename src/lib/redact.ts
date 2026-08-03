export interface RedactionResult {
  text: string
  /** Human-readable labels of what was redacted (never the secret itself) */
  found: string[]
}

/**
 * Redact high-confidence credentials before anything is written to the wiki.
 *
 * DELIBERATELY NARROW. Transcripts contain plenty of sensitive-LOOKING data
 * that is genuinely valuable wiki content — AWS account IDs, ARNs, bucket
 * names, hostnames, usernames, resource IDs, ticket keys. Those are NEVER
 * touched. Only patterns that are unambiguously secret material are replaced,
 * and the surrounding context is preserved so the page still reads correctly
 * (e.g. "export AWS_SECRET_ACCESS_KEY=[REDACTED:aws-secret-key]").
 *
 * Every hit is reported to the caller so a redaction is visible, never silent.
 */
/**
 * Accessors that mean "this value lives elsewhere" — the line documents the
 * SOURCE of a credential, not the credential. Requiring a trailing `.`, `[`
 * or `(` keeps it precise: a literal password is never `var.` + identifier.
 */
const CODE_REF =
  "(?:var|local|data|module|self|this|env|config|settings|params|opts|options|" +
  "process|os|System|ENV|Deno|secrets|inputs|vault|state)[.\\[(]"

const PATTERNS: Array<{ label: string; regex: RegExp; replace?: (match: string, ...groups: string[]) => string }> = [
  // Private key blocks (any type: RSA, OPENSSH, EC, PGP...)
  {
    label: "private-key-block",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // AWS access key IDs — fixed, unmistakable prefixes
  { label: "aws-access-key-id", regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  // AWS secret access key: only when explicitly assigned to a known key name
  {
    label: "aws-secret-key",
    regex: /(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)(\s*[=:]\s*)["']?[A-Za-z0-9/+=]{40}["']?/g,
    replace: (_m, name, sep) => `${name}${sep}[REDACTED:aws-secret-key]`,
  },
  // Vendor API keys with distinctive prefixes
  { label: "openai-key", regex: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { label: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { label: "slack-token", regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { label: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // JWTs (three base64url segments) — almost always a live credential
  { label: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Authorization headers
  {
    label: "bearer-token",
    regex: /(Authorization\s*:\s*)(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: (_m, prefix, scheme) => `${prefix}${scheme} [REDACTED:bearer-token]`,
  },
  // Credentials embedded in URLs: scheme://user:secret@host
  // Placeholders are exempt — CI config is full of ${CI_JOB_TOKEN}@host, and
  // the variable NAME is documentation, not a secret.
  {
    label: "url-password",
    regex: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):(?![$<*])(?!REDACTED)[^\s@/]{3,}@/gi,
    replace: (_m, userPart) => `${userPart}:[REDACTED:url-password]@`,
  },
  // Explicit password/secret/token assignments with a LITERAL value.
  //
  // Three exemptions, all of which are identifiers rather than credentials:
  //  - (?<![:/]) — a keyword preceded by ':' or '/' belongs to a URI, ARN or
  //    path, never an assignment. Without this, the trailing segment of
  //    arn:aws:secretsmanager:...:secret:dev/app/db-AbCdEf gets destroyed,
  //    taking the secret's NAME (what a reader actually needs) with it.
  //  - CODE_REF — `password = var.db_password`, `api_key = os.environ[...]`
  //    documents where a credential comes from; redacting it removes the only
  //    useful information on the line.
  //  - placeholders: <...>, ${...}, $VAR, ***, xxx, REDACTED
  {
    label: "assigned-secret",
    regex: new RegExp(
      `(?<![:/])\\b(password|passwd|secret|api_key|apikey|access_token|auth_token|client_secret)` +
        `(\\s*[=:]\\s*)["']?` +
        `((?!\\s)(?![<$*])(?!x{3,})(?!REDACTED)(?!${CODE_REF})[^\\s"',;]{6,})["']?`,
      "gi"
    ),
    replace: (_m, name, sep) => `${name}${sep}[REDACTED:${name.toLowerCase()}]`,
  },
]

/** Strip credentials from text. Returns cleaned text plus labels of hits. */
export function redactSecrets(text: string): RedactionResult {
  let out = text
  const found: string[] = []

  for (const { label, regex, replace } of PATTERNS) {
    regex.lastIndex = 0
    if (!regex.test(out)) continue
    found.push(label)
    regex.lastIndex = 0
    out = replace
      ? out.replace(regex, replace as (substring: string, ...args: any[]) => string)
      : out.replace(regex, `[REDACTED:${label}]`)
  }

  return { text: out, found }
}
