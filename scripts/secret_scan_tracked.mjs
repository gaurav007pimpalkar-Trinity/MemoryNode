#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  detectSecretReason,
  extractEnvStyleAssignment,
  isEnvLikePath,
  isLikelyPlaceholder,
  normalizeSecretValue,
  redactSecret,
  scanWranglerTomlSecrets,
} from "./lib/secret_scan_core.mjs";

const MAX_FILE_BYTES = 2_000_000;
const EXCLUDED_PREFIXES = [
  "node_modules/",
  ".git/",
  ".pnpm-store/",
  ".tmp/",
  "dist/",
  "build/",
  "coverage/",
];

const TOKEN_RULES = [
  { name: "mn_live token", re: /\bmn_live_[A-Za-z0-9_-]{20,}\b/g },
  { name: "mn_a token", re: /\bmn_a[A-Za-z0-9_-]{20,}\b/g },
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "Router-style key", re: /\brk_[A-Za-z0-9_-]{20,}\b/g },
  { name: "Stripe webhook secret", re: /\bwhsec_[A-Za-z0-9_-]{16,}\b/g },
  { name: "Slack token", re: /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/gi },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z\-_]{16,}\b/g },
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

const SUSPICIOUS_CONTEXT_RE =
  /\b(authorization|bearer|token|api[-_]?key|x-api-key|secret|password|private[-_]?key|session)\b/i;
const SUSPICIOUS_KEY_RE =
  /(^|[_-])(token|api[-_]?key|secret|password|private[-_]?key|bearer|session|authorization)([_-]|$)/i;
const LITERAL_TOKEN_RE = /^[A-Za-z0-9._~+/\-=]{8,}$/;

function normalizePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function runGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  });
}

function shouldSkipFile(filePath) {
  const normalized = normalizePath(filePath);
  return EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function addFinding(findings, finding) {
  const key = `${finding.file}|${finding.line}|${finding.rule}|${finding.match}`;
  if (!findings.seen.has(key)) {
    findings.seen.add(key);
    findings.items.push(finding);
  }
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

function looksHighEntropyToken(value) {
  if (value.length < 30) return false;
  if (!LITERAL_TOKEN_RE.test(value)) return false;
  const compact = value.replace(/[._-]/g, "");
  if (!/[A-Za-z]/.test(compact) || !/[0-9]/.test(compact)) return false;
  return shannonEntropy(compact) >= 3.5;
}

function matchesRuleValue(rule, value) {
  rule.re.lastIndex = 0;
  return rule.re.test(value);
}

function findTokenRule(value) {
  for (const rule of TOKEN_RULES) {
    if (matchesRuleValue(rule, value)) return rule;
  }
  return null;
}

function inspectTokenRules(line, filePath, lineNumber, findings) {
  if (line.includes("${{ secrets.") || line.includes("${{ env.")) {
    return;
  }
  const exampleContext = /(sample|example|fixture|dummy|placeholder|test-only|dev-only|mock|stub)/i.test(line);
  for (const rule of TOKEN_RULES) {
    rule.re.lastIndex = 0;
    const matches = line.matchAll(rule.re);
    for (const match of matches) {
      const candidate = normalizeSecretValue(match[0] || "");
      if (!candidate) continue;
      if (exampleContext) continue;
      if (isLikelyPlaceholder(candidate)) continue;
      addFinding(findings, {
        file: filePath,
        line: lineNumber,
        rule: rule.name,
        match: candidate,
      });
    }
  }
}

function inspectEnvAssignment(line, filePath, lineNumber, findings) {
  const assignment = extractEnvStyleAssignment(line);
  if (!assignment) return;
  const reason = detectSecretReason(assignment.key, assignment.rawValue, {
    allowSensitiveName: true,
    allowEntropy: true,
  });
  if (!reason) return;
  addFinding(findings, {
    file: filePath,
    line: lineNumber,
    rule: `${assignment.key} assignment (${reason})`,
    match: normalizeSecretValue(assignment.rawValue),
  });
}

function inspectSuspiciousContext(line, filePath, lineNumber, findings) {
  if (!SUSPICIOUS_CONTEXT_RE.test(line)) return;
  if (line.includes("${{ secrets.") || line.includes("${{ env.")) return;

  const bearerMatches = line.matchAll(/\bauthorization\b\s*[:=]\s*["'`]?bearer\s+([A-Za-z0-9._~+/\-=]{8,})/gi);
  for (const match of bearerMatches) {
    const candidate = normalizeSecretValue(match[1] || "");
    if (!candidate || isLikelyPlaceholder(candidate)) continue;
    const reason =
      findTokenRule(candidate)?.name ??
      (looksHighEntropyToken(candidate) ? "high-entropy bearer token" : null);
    if (!reason) continue;
    addFinding(findings, {
      file: filePath,
      line: lineNumber,
      rule: `authorization bearer context (${reason})`,
      match: candidate,
    });
  }

  const assignmentMatches = line.matchAll(
    /["'`]?([A-Za-z_][A-Za-z0-9_.-]{1,120})["'`]?\s*[:=]\s*("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`|[A-Za-z0-9._~+/\-=]{8,})/g,
  );

  for (const match of assignmentMatches) {
    const key = match[1];
    const rawValue = match[2];
    if (!SUSPICIOUS_KEY_RE.test(key)) continue;
    if (/\$\{[^}]+\}/.test(rawValue) || /\$\{\{[^}]+\}\}/.test(rawValue)) continue;
    const candidate = normalizeSecretValue(rawValue);
    if (!candidate || isLikelyPlaceholder(candidate)) continue;
    if (!LITERAL_TOKEN_RE.test(candidate) && !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(candidate)) continue;

    const reason =
      findTokenRule(candidate)?.name ??
      (looksHighEntropyToken(candidate) ? "high-entropy token in sensitive assignment" : null);
    if (!reason) continue;
    addFinding(findings, {
      file: filePath,
      line: lineNumber,
      rule: `${key} assignment (${reason})`,
      match: candidate,
    });
  }
}

function scanWranglerFileContent(content, filePath, findings) {
  const wranglerFindings = scanWranglerTomlSecrets(content, filePath);
  for (const finding of wranglerFindings) {
    addFinding(findings, {
      file: finding.file,
      line: finding.line,
      rule: `${finding.key} in [${finding.section}] (${finding.reason})`,
      match: finding.value,
    });
  }
}

function listTrackedFiles() {
  const raw = runGit(["ls-files", "-z"]);
  return raw.split("\u0000").filter(Boolean).map(normalizePath);
}

function scanTrackedFiles() {
  const findings = { seen: new Set(), items: [] };
  const files = listTrackedFiles();

  for (const file of files) {
    if (shouldSkipFile(file)) continue;

    let content;
    try {
      const buffer = fs.readFileSync(file);
      if (buffer.length > MAX_FILE_BYTES) continue;
      if (buffer.includes(0)) continue;
      content = buffer.toString("utf8");
    } catch {
      continue;
    }

    if (file.toLowerCase().endsWith("wrangler.toml")) {
      scanWranglerFileContent(content, file, findings);
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineNumber = i + 1;
      inspectTokenRules(line, file, lineNumber, findings);
      inspectSuspiciousContext(line, file, lineNumber, findings);
      if (isEnvLikePath(file)) {
        inspectEnvAssignment(line, file, lineNumber, findings);
      }
    }
  }

  findings.items.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    return a.rule.localeCompare(b.rule);
  });
  return findings;
}

function printFindings(findings) {
  if (findings.items.length === 0) {
    console.log("Tracked-file secret scan passed.");
    return;
  }
  console.error("Tracked-file secret scan failed. Potential secret-like values were detected:");
  for (const finding of findings.items) {
    console.error(` - ${finding.file}:${finding.line} ${finding.rule} (${redactSecret(finding.match)})`);
  }
  console.error("Remove secrets from tracked files and use Cloudflare Dashboard/Wrangler secrets.");
  process.exit(1);
}

function main() {
  const findings = scanTrackedFiles();
  printFindings(findings);
}

main();
