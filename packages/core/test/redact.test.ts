import { describe, expect, it } from "vitest";
import { isSensitivePath, newReport, redactDeep, redactText } from "../src/redact.ts";

describe("redactText", () => {
  const cases: [string, string, string][] = [
    ["anthropic", `key sk-ant-api03-${"a".repeat(40)} end`, "anthropic_key"],
    ["openai", `OPENAI=sk-proj-${"B".repeat(40)}`, "openai_key"],
    ["aws", "aws AKIAIOSFODNN7EXAMPLE here", "aws_access_key"],
    ["github", `token ghp_${"x".repeat(36)}`, "github_token"],
    ["stripe", `sk_live_${"9".repeat(24)}`, "stripe_key"],
    ["google", `AIza${"Q".repeat(35)}`, "google_api_key"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", "jwt"],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----", "private_key"],
  ];
  for (const [name, input, kind] of cases) {
    it(`redacts ${name}`, () => {
      const r = newReport();
      const out = redactText(input, r);
      expect(out).toContain(`[REDACTED:${kind}]`);
      expect(r.kinds[kind]).toBe(1);
    });
  }

  it("keeps the variable name but hides the value in assignments", () => {
    expect(redactText('DB_PASSWORD="hunter2hunter2"')).toBe('DB_PASSWORD="[REDACTED:secret_assignment]"');
    expect(redactText('{"api_key": "abcdefgh12345678"}')).toBe('{"api_key": "[REDACTED:secret_assignment]"}');
    expect(redactText("FOO=1\nexport STRIPE_SECRET=abcd1234efgh\n")).toBe("FOO=1\nexport STRIPE_SECRET=[REDACTED:secret_assignment]\n");
  });

  it("keeps bearer prefix and url user", () => {
    expect(redactText(`Authorization: Bearer ${"t".repeat(30)}`)).toBe("Authorization: Bearer [REDACTED:bearer_token]");
    expect(redactText("postgres://admin:s3cretpw@db:5432/x")).toBe("postgres://admin:[REDACTED:url_credentials]@db:5432/x");
  });

  it("leaves ordinary code alone", () => {
    const code = "const tokenCount = items.length;\nfunction getPassword() { return prompt(); }\nnpm run build";
    expect(redactText(code)).toBe(code);
  });

  it("is idempotent", () => {
    const once = redactText(`sk-ant-api03-${"a".repeat(40)}`);
    expect(redactText(once)).toBe(once);
  });

  it("redacts nested values", () => {
    const r = newReport();
    const out = redactDeep({ a: [{ b: "AKIAIOSFODNN7EXAMPLE" }], n: 3 }, r);
    expect(out).toEqual({ a: [{ b: "[REDACTED:aws_access_key]" }], n: 3 });
    expect(r.count).toBe(1);
  });
});

describe("isSensitivePath", () => {
  it("flags secret-bearing files", () => {
    for (const p of [".env", "app/.env.local", "certs/server.pem", "/home/u/.ssh/config", "id_ed25519", ".npmrc", "config/credentials"])
      expect(isSensitivePath(p), p).toBe(true);
  });
  it("allows normal and example files", () => {
    for (const p of ["src/env.ts", ".env.example", "README.md", "src/keyboard.tsx", "tokens.css"])
      expect(isSensitivePath(p), p).toBe(false);
  });
});
