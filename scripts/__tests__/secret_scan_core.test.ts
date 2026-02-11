import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectSecretReason, scanWranglerTomlSecrets } from "../lib/secret_scan_core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, "fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

describe("wrangler secret scanner", () => {
  it("passes safe placeholders across vars/env vars blocks", () => {
    const raw = readFixture("wrangler.safe.toml");
    const findings = scanWranglerTomlSecrets(raw, "apps/api/wrangler.toml");
    expect(findings).toEqual([]);
  });

  it("detects secret-like value inside env.production.vars", () => {
    const openAiLike = ["sk", "-", "live", "_", "A".repeat(36)].join("");
    const raw = readFixture("wrangler.secret-env.toml").replace("<OPENAI_VALUE>", openAiLike);
    const findings = scanWranglerTomlSecrets(raw, "apps/api/wrangler.toml");

    expect(findings.some((f) => f.section === "env.production.vars" && f.key === "OPENAI_API_KEY")).toBe(true);
  });

  it("detects secret-like value in top-level vars", () => {
    const webhookLike = ["whsec", "_", "B".repeat(36)].join("");
    const raw = readFixture("wrangler.secret-top.toml").replace("<WEBHOOK_VALUE>", webhookLike);
    const findings = scanWranglerTomlSecrets(raw, "apps/api/wrangler.toml");

    expect(findings.some((f) => f.section === "vars" && f.key === "STRIPE_WEBHOOK_SECRET")).toBe(true);
  });

  it("allows placeholders and non-secret mode values", () => {
    expect(detectSecretReason("OPENAI_API_KEY", "<YOUR_OPENAI_API_KEY>")).toBeNull();
    expect(detectSecretReason("EMBEDDINGS_MODE", "openai")).toBeNull();
  });
});
