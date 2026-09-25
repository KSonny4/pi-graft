// A fake pi: records hooks, tools and commands registered by the real
// extension and lets a test fire events at them.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_GRAFT = join(here, "fake-graft.sh");

/** A repo dir with a built-looking graph and a call log for the fake CLI. */
export function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "pi-graft-test-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "graft", ".graph"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "graft", ".graph", "wiring.json"), JSON.stringify({ nodes: [], edges: [] }));
  writeFileSync(join(repo, "graft", "INDEX.md"), "# graft — repo map\n");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  return { root, repo, log: join(root, "graft-calls.log") };
}

/** Env the extension reads at import time; set before importing it. */
export function graftEnv(log) {
  return { GRAFT_BIN: FAKE_GRAFT, GRAFT_LOG: log };
}

export function fakePi() {
  const handlers = new Map();
  const tools = [];
  const commands = [];
  return {
    handlers, tools, commands,
    on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    registerTool(tool) { tools.push(tool.name); },
    registerCommand(name) { commands.push(name); },
    async fire(name, event, ctx) {
      let last;
      for (const fn of handlers.get(name) ?? []) last = await fn(event, ctx);
      return last;
    },
  };
}

export function fakeCtx(cwd) {
  return {
    cwd,
    sessionManager: { getSessionId: () => "test-session" },
    ui: { setStatus() {}, notify() {} },
    getSystemPrompt: () => "",
  };
}
