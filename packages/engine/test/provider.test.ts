import { describe, expect, it } from "vitest";
import { childEnv, explainFailure } from "../src/provider.ts";

const env = {
  PATH: "/usr/bin", HOME: "/Users/x",
  ANTHROPIC_API_KEY: "sk-ant-secret", ANTHROPIC_BASE_URL: "http://proxy", ANTHROPIC_AUTH_TOKEN: "t",
  CLAUDE_CODE_SESSION_ID: "abc", CLAUDE_CODE_MESSAGING_TOKEN: "m", CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDECODE: "1",
};

describe("childEnv", () => {
  it("account mode never passes an API key or another session's internals, and blanks the key", () => {
    const e = childEnv("account", env);
    expect(e.ANTHROPIC_API_KEY).toBe("");
    for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDECODE"])
      expect(e[k], k).toBeUndefined();
    expect(e.PATH).toBe("/usr/bin");
    expect(JSON.stringify(e)).not.toContain("sk-ant-secret");
  });
  it("api-key mode keeps the key but still drops session internals", () => {
    const e = childEnv("api-key", env);
    expect(e.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
    expect(e.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(e.CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined();
  });
});

describe("explainFailure", () => {
  it("turns billing and sign-in errors into actionable messages", () => {
    expect(explainFailure("Credit balance is too low", "account")).toMatch(/Sign in to Claude Code with your Claude account/);
    expect(explainFailure("Credit balance is too low", "api-key")).toMatch(/API credit balance is too low/);
    expect(explainFailure("Not logged in · Please run /login", "account")).toMatch(/claude auth login/);
  });
});
