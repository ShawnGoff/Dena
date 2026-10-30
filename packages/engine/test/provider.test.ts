import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkAgainstSchema, childEnv, ClaudeCodeProvider, describeSchema, explainFailure, parseJsonAnswer } from "../src/provider.ts";

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

describe("plain JSON answers", () => {
  const schema = { type: "object", properties: { title: { type: "string" }, refs: { type: "array", items: { type: "string", pattern: "^E[0-9]+$" } }, kind: { type: "string", enum: ["observed", "inferred"] } },
    required: ["title", "refs", "kind"], additionalProperties: false };

  it("describes the format compactly, reads fenced answers, and lists what is wrong", () => {
    expect(describeSchema(schema)).toBe('{\n  title: string,\n  refs: string /* matching ^E[0-9]+$ */[],\n  kind: "observed" | "inferred"\n}');
    expect(parseJsonAnswer('```json\n{"a": 1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonAnswer("Here it is: {\"a\": 1} done")).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonAnswer("no json").ok).toBe(false);
    expect(checkAgainstSchema({ title: "t", refs: ["E1", "S2"], kind: "maybe" }, schema)).toEqual(["answer.refs[1] must match ^E[0-9]+$", 'answer.kind must be one of "observed", "inferred"']);
    expect(checkAgainstSchema({ refs: [] }, schema)).toEqual(["answer.title is missing", "answer.kind is missing"]);
  });

  it("answers in one turn, retries once with the problems, and falls back to the structured tool", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dena-fakeclaude-"));
    const log = path.join(dir, "calls.log");
    // A fake Claude Code: logs whether it was given --json-schema, and answers from a list of replies, one per call.
    const replies = [
      '{"type":"result","subtype":"success","result":"Sure! {\\"title\\": \\"t\\"}","usage":{"input_tokens":100,"output_tokens":10}}',
      '{"type":"result","subtype":"success","result":"{\\"title\\": \\"t\\", \\"refs\\": [\\"E1\\"], \\"kind\\": \\"observed\\"}","usage":{"input_tokens":100,"cache_read_input_tokens":90,"output_tokens":12}}',
    ];
    fs.writeFileSync(path.join(dir, "replies"), replies.join("\n"));
    const bin = path.join(dir, "claude");
    fs.writeFileSync(bin, `#!/bin/sh
case " $* " in *" --json-schema "*) echo tool >> "${log}";; *) echo text >> "${log}";; esac
cat > /dev/null
n=$(wc -l < "${log}")
sed -n "\${n}p" "${dir}/replies"
`, { mode: 0o755 });
    const r = await new ClaudeCodeProvider(bin).generate("system", "user", schema);
    expect(r.json).toEqual({ title: "t", refs: ["E1"], kind: "observed" });
    expect(r.calls).toBe(2);
    expect(r.tokens).toMatchObject({ prompt: 290, output: 22 });
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual(["text", "text"]); // no structured-output tool needed

    // Two bad answers: the third call uses the structured-output tool.
    fs.writeFileSync(log, "");
    fs.writeFileSync(path.join(dir, "replies"), [replies[0], replies[0], '{"type":"result","subtype":"success","result":"","structured_output":{"title":"x","refs":[],"kind":"inferred"}}'].join("\n"));
    const r2 = await new ClaudeCodeProvider(bin).generate("system", "user", schema);
    expect(r2.json).toEqual({ title: "x", refs: [], kind: "inferred" });
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual(["text", "text", "tool"]);
  });
});
