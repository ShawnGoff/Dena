import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearServerInfo, runningServer, serverKey, servicePlan, stableNode, writeServerInfo } from "../src/launch.ts";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-launch-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("starting Dena", () => {
  it("keeps the same key between runs, readable only by you, until asked for a new one", () => {
    const a = serverKey(home);
    expect(serverKey(home)).toBe(a);
    // Owner-only file modes are a macOS/Linux idea; Windows keeps a file in the user's own profile instead.
    if (process.platform !== "win32") expect(fs.statSync(path.join(home, "server-key")).mode & 0o777).toBe(0o600);
    const b = serverKey(home, { renew: true });
    expect(b).not.toBe(a);
    expect(serverKey(home)).toBe(b);
  });

  it("only reports a server that is really running, and forgets its own note when it stops", async () => {
    expect(await runningServer(home)).toBeNull();
    writeServerInfo(home, { pid: 999_999_9, port: 1, url: "x", startedAt: "t" }); // a process that does not exist
    expect(await runningServer(home)).toBeNull();
    writeServerInfo(home, { pid: process.pid, port: 1, url: "x", startedAt: "t" }); // alive, but nothing answers on the port
    expect(await runningServer(home)).toBeNull();
    clearServerInfo(home, 123); // someone else's pid: the note stays
    expect(fs.existsSync(path.join(home, "server.json"))).toBe(true);
    clearServerInfo(home);
    expect(fs.existsSync(path.join(home, "server.json"))).toBe(false);
  });

  it("starts the login item with a Node path that survives upgrades, and a usable PATH", () => {
    expect(stableNode("/usr/local/bin/node")).toBe("/usr/local/bin/node");
    expect(stableNode("/nowhere/Cellar/node@22/22.1.0/bin/node")).toBe("/nowhere/Cellar/node@22/22.1.0/bin/node"); // no stable link to use
    const plan = servicePlan(home, 4601);
    expect(plan.command.slice(-3)).toEqual(["serve", "--port", "4601"]);
    expect(plan.plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plan.plist).toContain(`<key>DENA_HOME</key><string>${home}</string>`);
    expect(plan.plist).toMatch(/<key>PATH<\/key><string>[^<]*\/usr\/bin/);
    expect(plan.log).toBe(path.join(home, "logs", "server.log"));
  });
});
