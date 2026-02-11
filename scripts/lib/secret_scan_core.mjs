const SECRET_PREFIX_RULES = [
  { label: "OpenAI-style key", re: /^sk-[A-Za-z0-9_-]{10,}$/ },
  { label: "Router-style key", re: /^rk_[A-Za-z0-9_-]{10,}$/ },
  { label: "Stripe webhook secret", re: /^whsec_[A-Za-z0-9_-]{10,}$/ },
  { label: "Slack token", re: /^xox[a-z]-[A-Za-z0-9-]{10,}$/i },
  { label: "Google API key", re: /^AIza[0-9A-Za-z\-_]{10,}$/ },
  { label: "PEM private key", re: /^-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const SENSITIVE_NAME_RE = /(^|_)(KEY|SECRET|TOKEN|PASSWORD|PRIVATE|BEARER|SESSION)(_|$)/i;
const NON_SECRET_NAME_RE = /(^|_)(ANON_KEY|PUBLIC_KEY)(_|$)/i;

const PLACEHOLDER_EXACT = new Set([
  "",
  "redacted",
  "changeme",
  "change_me",
  "replace_me",
  "placeholder",
  "example",
  "dummy",
  "stub",
  "dev",
  "local",
  "test",
  "todo",
  "tbd",
  "none",
  "null",
  "...",
]);

const PLACEHOLDER_HINTS = [
  "placeholder",
  "example",
  "redacted",
  "changeme",
  "change-me",
  "replace",
  "your_",
  "your-",
  "public-anon-key",
];

export function redactSecret(value) {
  if (!value) return "***";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

export function stripInlineComment(raw) {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && (inSingle || inDouble)) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "#" && !inSingle && !inDouble) {
      return raw.slice(0, i).trim();
    }
  }
  return raw.trim();
}

export function normalizeSecretValue(rawValue) {
  const stripped = stripInlineComment(`${rawValue ?? ""}`).trim();
  if (!stripped) return "";

  const first = stripped[0];
  const last = stripped[stripped.length - 1];
  const quoted = (first === '"' && last === '"') || (first === "'" && last === "'") || (first === "`" && last === "`");
  const unwrapped = quoted ? stripped.slice(1, -1).trim() : stripped.trim();
  return unwrapped.replace(/[;,]+$/, "").trim();
}

export function isLikelyPlaceholder(rawValue) {
  const value = normalizeSecretValue(rawValue);
  if (!value) return true;

  const lower = value.toLowerCase();
  if (PLACEHOLDER_EXACT.has(lower)) return true;
  if (PLACEHOLDER_HINTS.some((hint) => lower.includes(hint))) return true;
  if (/^(dev|local|dummy|stub)([_-].+)?$/i.test(value)) return true;
  if (/^<[^>]+>$/.test(value)) return true;
  if (/^\{\{[^}]+\}\}$/.test(value)) return true;
  if (/^\$\{\{[^}]+\}\}$/.test(value)) return true;
  if (/^\$\{[^}]+\}$/.test(value)) return true;
  if (/^\$\([^)]+\)$/.test(value)) return true;
  if (/^x{6,}$/i.test(value)) return true;
  if (/_xxx$/i.test(value)) return true;
  if (/^mn_live_x+$/i.test(value)) return true;
  return false;
}

export function isSensitiveKeyName(keyName) {
  const key = `${keyName ?? ""}`.trim();
  if (!key) return false;
  if (NON_SECRET_NAME_RE.test(key)) return false;
  return SENSITIVE_NAME_RE.test(key);
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function looksHighEntropySecret(value) {
  if (value.length < 30) return false;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  return shannonEntropy(value) >= 3.5;
}

function findSecretPrefixRule(value) {
  return SECRET_PREFIX_RULES.find((rule) => rule.re.test(value)) || null;
}

export function detectSecretReason(keyName, rawValue, options = {}) {
  const opts = {
    allowSensitiveName: true,
    allowEntropy: true,
    ...options,
  };

  const value = normalizeSecretValue(rawValue);
  if (isLikelyPlaceholder(value)) return null;

  const prefixRule = findSecretPrefixRule(value);
  if (prefixRule) return prefixRule.label;

  if (opts.allowSensitiveName && isSensitiveKeyName(keyName)) {
    return "sensitive variable name with non-placeholder value";
  }

  if (opts.allowEntropy && looksHighEntropySecret(value)) {
    return "long high-entropy token";
  }

  return null;
}

export function extractEnvStyleAssignment(line) {
  const match = line.match(/^\s*(?:export\s+)?["'`]?([A-Z][A-Z0-9_]{1,120})["'`]?\s*[:=]\s*(.*)$/);
  if (!match) return null;
  return { key: match[1], rawValue: match[2] ?? "" };
}

export function isWranglerVarsSection(sectionName) {
  if (!sectionName) return false;
  const section = sectionName.trim().toLowerCase();
  return section === "vars" || /^env\.[^.]+\.vars$/.test(section);
}

export function isWranglerEnvRootSection(sectionName) {
  if (!sectionName) return false;
  return /^env\.[^.]+$/i.test(sectionName.trim());
}

export function parseWranglerTomlAssignments(rawToml) {
  const assignments = [];
  const lines = rawToml.split(/\r?\n/);
  let section = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const arrayHeader = trimmed.match(/^\[\[([^\]]+)\]\]\s*$/);
    if (arrayHeader) {
      section = arrayHeader[1].trim();
      continue;
    }

    const header = trimmed.match(/^\[([^\]]+)\]\s*$/);
    if (header) {
      section = header[1].trim();
      continue;
    }

    const assignment = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (!assignment) continue;

    assignments.push({
      section,
      key: assignment[1],
      rawValue: assignment[2],
      line: i + 1,
    });
  }

  return assignments;
}

export function scanWranglerTomlSecrets(rawToml, filePath = "apps/api/wrangler.toml") {
  const findings = [];
  const assignments = parseWranglerTomlAssignments(rawToml);

  for (const item of assignments) {
    const inVars = isWranglerVarsSection(item.section);
    const inEnvRoot = isWranglerEnvRootSection(item.section);
    if (!inVars && !inEnvRoot) continue;

    const reason = detectSecretReason(item.key, item.rawValue, {
      allowSensitiveName: true,
      allowEntropy: inVars,
    });
    if (!reason) continue;

    findings.push({
      file: filePath,
      line: item.line,
      section: item.section || "<root>",
      key: item.key,
      value: normalizeSecretValue(item.rawValue),
      reason,
    });
  }

  return findings;
}

export function isEnvLikePath(filePath) {
  const normalized = `${filePath}`.replace(/\\/g, "/");
  return (
    /(^|\/)\.env(\..+)?$/i.test(normalized) ||
    /(^|\/)\.dev\.vars(\..+)?$/i.test(normalized) ||
    /(^|\/)[^/]+\.env$/i.test(normalized)
  );
}
