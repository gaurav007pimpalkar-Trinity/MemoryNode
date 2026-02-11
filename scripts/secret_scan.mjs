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
const EXCLUDED_TRACKED_FILES = new Set(["scripts/secret_scan.mjs", "staged_files.txt"]);
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
  { name: "Stripe webhook secret", re: /\bwhsec_[A-Za-z0-9_-]{10,}\b/g },
  { name: "Slack token", re: /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/gi },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z\-_]{16,}\b/g },
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

function normalizePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function runGit(args, allowFailure = false) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    if (allowFailure) return String(error.stdout || "");
    throw error;
  }
}

function isAllZeroSha(value) {
  return !value || /^0+$/.test(value);
}

function isWranglerTomlPath(filePath) {
  return normalizePath(filePath).toLowerCase().endsWith("wrangler.toml");
}

function shouldSkipFile(filePath) {
  const normalized = normalizePath(filePath);
  if (EXCLUDED_TRACKED_FILES.has(normalized)) return true;
  return EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function addFinding(findings, finding) {
  const key = `${finding.source}|${finding.file}|${finding.line}|${finding.rule}|${finding.match}`;
  if (!findings.seen.has(key)) {
    findings.seen.add(key);
    findings.items.push(finding);
  }
}

function inspectTokenRules(line, filePath, lineNumber, source, findings) {
  if (line.includes("${{ secrets.") || line.includes("${{ env.")) {
    return;
  }
  const exampleContext = /(sample|example|fixture|dummy|placeholder)/i.test(line);

  for (const rule of TOKEN_RULES) {
    const matches = line.matchAll(rule.re);
    for (const match of matches) {
      const candidate = normalizeSecretValue(match[0] || "");
      if (!candidate) continue;
      if (exampleContext) continue;
      if (isLikelyPlaceholder(candidate)) continue;
      addFinding(findings, {
        source,
        file: filePath,
        line: lineNumber,
        rule: rule.name,
        match: candidate,
      });
    }
  }
}

function inspectAssignmentLine(line, filePath, lineNumber, source, findings, allowEntropy) {
  if (line.includes("${{ secrets.") || line.includes("${{ env.")) {
    return;
  }
  const assignment = extractEnvStyleAssignment(line);
  if (!assignment) return;

  const reason = detectSecretReason(assignment.key, assignment.rawValue, {
    allowSensitiveName: true,
    allowEntropy,
  });
  if (!reason) return;

  addFinding(findings, {
    source,
    file: filePath,
    line: lineNumber,
    rule: `${assignment.key} assignment (${reason})`,
    match: normalizeSecretValue(assignment.rawValue),
  });
}

function scanEnvLikeFileContent(content, filePath, source, findings) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    inspectAssignmentLine(lines[i], filePath, i + 1, source, findings, true);
  }
}

function scanWranglerFileContent(content, filePath, source, findings) {
  const wranglerFindings = scanWranglerTomlSecrets(content, filePath);
  for (const finding of wranglerFindings) {
    addFinding(findings, {
      source,
      file: finding.file,
      line: finding.line,
      rule: `${finding.key} in [${finding.section}] (${finding.reason})`,
      match: finding.value,
    });
  }
}

function scanDiffAddedLines(diffText, source, findings) {
  const lines = diffText.split(/\r?\n/);
  let currentFile = "";
  let currentLine = 0;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const rawPath = line.slice(4).trim();
      if (rawPath === "/dev/null") {
        currentFile = "";
        currentLine = 0;
      } else {
        currentFile = normalizePath(rawPath.startsWith("b/") ? rawPath.slice(2) : rawPath);
      }
      continue;
    }

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      currentLine = Number(hunk[1]);
      continue;
    }

    if (!currentFile || shouldSkipFile(currentFile)) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const added = line.slice(1);
      inspectTokenRules(added, currentFile, currentLine, source, findings);
      const shouldScanAssignment = isWranglerTomlPath(currentFile) || isEnvLikePath(currentFile);
      if (shouldScanAssignment) {
        inspectAssignmentLine(added, currentFile, currentLine, source, findings, true);
      }
      currentLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }

    if (!line.startsWith("\\")) {
      currentLine += 1;
    }
  }
}

function scanTrackedFiles(findings) {
  const listed = runGit(["ls-files", "-z"], true);
  const files = listed.split("\u0000").filter(Boolean).map(normalizePath);

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

    if (isWranglerTomlPath(file)) {
      scanWranglerFileContent(content, file, "tracked", findings);
      continue;
    }

    if (isEnvLikePath(file)) {
      scanEnvLikeFileContent(content, file, "tracked", findings);
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      inspectTokenRules(lines[i], file, i + 1, "tracked", findings);
    }
  }
}

function parseArgs(argv) {
  const options = {
    mode: "staged",
    base: "",
    head: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ci") options.mode = "ci";
    if (arg === "--staged") options.mode = "staged";
    if (arg === "--base" && i + 1 < argv.length) {
      options.base = argv[i + 1];
      i += 1;
    }
    if (arg === "--head" && i + 1 < argv.length) {
      options.head = argv[i + 1];
      i += 1;
    }
  }

  return options;
}

function printResult(findings, mode) {
  if (findings.items.length === 0) {
    console.log(`Secret scan passed (${mode}).`);
    return;
  }

  console.error("Secret scan failed. Potential secret-like values were detected:");
  for (const finding of findings.items) {
    console.error(
      ` - [${finding.source}] ${finding.file}:${finding.line} ${finding.rule} (${redactSecret(finding.match)})`,
    );
  }
  console.error("Remove secrets from tracked files/diffs and use Cloudflare Dashboard secrets instead.");
  process.exit(1);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const findings = { seen: new Set(), items: [] };

  if (options.mode === "staged") {
    const stagedDiff = runGit(["diff", "--cached", "--no-color", "--unified=0"], true);
    if (stagedDiff.trim()) {
      scanDiffAddedLines(stagedDiff, "staged", findings);
    }
    printResult(findings, "staged diff");
    return;
  }

  scanTrackedFiles(findings);

  if (!isAllZeroSha(options.base) && !isAllZeroSha(options.head)) {
    const rangeDiff = runGit(
      ["diff", "--no-color", "--unified=0", `${options.base}..${options.head}`],
      true,
    );
    if (rangeDiff.trim()) {
      scanDiffAddedLines(rangeDiff, "range", findings);
    }
  }

  printResult(findings, "ci");
}

main();
