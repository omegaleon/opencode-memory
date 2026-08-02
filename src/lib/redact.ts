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
  {
    label: "url-password",
    regex: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]{3,}@/gi,
    replace: (_m, userPart) => `${userPart}:[REDACTED:url-password]@`,
  },
  // Explicit password/secret/token assignments with a literal value.
  // Placeholders (<...>, ${...}, $VAR, ***, REDACTED, xxx) are left alone.
  {
    label: "assigned-secret",
    regex:
      /\b(password|passwd|secret|api_key|apikey|access_token|auth_token|client_secret)(\s*[=:]\s*)["']?((?!\s)(?![<$*])(?!x{3,})(?!REDACTED)[^\s"',;]{6,})["']?/gi,
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
