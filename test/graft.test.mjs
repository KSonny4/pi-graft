import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeCtx, fakePi, graftEnv, makeRepo } from "./fixtures/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const shared = makeRepo();
Object.assign(process.env, graftEnv(shared.log));
const { default: extension } = await import("../extensions/graft.ts");

function load() {
  const pi = fakePi();
  extension(pi);
  return pi;
}

const stats = (repo) => JSON.parse(readFileSync(join(repo, "graft", ".cache", "stats.json"), "utf8"));
const calls = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test("registers the six graft tools, four commands and five hooks", () => {
  const pi = load();
  assert.deepEqual(pi.tools.sort(), [
    "graft_check_freshness", "graft_file_api", "graft_find_all",
    "graft_find_code", "graft_repo_map", "graft_trace_calls",
  ]);
  assert.deepEqual(pi.commands.sort(), ["graft-build", "graft-check", "graft-map", "graft-status"]);
  for (const hook of ["session_start", "before_agent_start", "tool_result", "turn_end", "agent_settled"]) {
    assert.ok(pi.handlers.has(hook), `missing hook ${hook}`);
  }
});

test("a write marks the graph dirty with the stale count and file", async () => {
  const { repo } = makeRepo();
  const pi = load();
  await pi.fire("tool_result", { toolName: "write", input: { path: "src/a.ts" }, content: [] }, fakeCtx(repo));
  const s = stats(repo);
  assert.equal(s.dirty, true);
  assert.equal(s.staleCount, 1);
  assert.equal(s.lastFile, "a.ts");
});

test("a read or a write inside graft/ leaves the graph clean", async () => {
  const { repo } = makeRepo();
  const pi = load();
  const ctx = fakeCtx(repo);
  await pi.fire("tool_result", { toolName: "read", input: { path: "src/a.ts" }, content: [] }, ctx);
  await pi.fire("tool_result", { toolName: "write", input: { path: "graft/INDEX.md" }, content: [] }, ctx);
  assert.equal(existsSync(join(repo, "graft", ".cache", "stats.json")) && stats(repo).dirty, false);
});

test("settle rebuilds only after a write", async () => {
  const { repo } = makeRepo();
  const pi = load();
  const ctx = fakeCtx(repo);
  await pi.fire("agent_settled", {}, ctx);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!calls(shared.log).some((c) => c.startsWith("build")), "no build without a write");

  await pi.fire("tool_result", { toolName: "write", input: { path: "src/a.ts" }, content: [] }, ctx);
  await pi.fire("agent_settled", {}, ctx);
  assert.ok(await waitFor(() => calls(shared.log).some((c) => c.startsWith("build"))), "detached build ran");
  assert.ok(await waitFor(() => stats(repo).dirty === false), "build clears dirty");
});

// Regression: the settle hook's 120 s in-flight guard timer was not
// unref'd, so every `pi -p` that wrote a file lived ~2 minutes after it
// finished (graph-engineering prep jobs: +120 s per step).
test("a process that wrote and settled exits at once", { timeout: 30_000 }, async () => {
  const { repo, log } = makeRepo();
  const started = Date.now();
  const child = spawn(process.execPath, [
    "--experimental-strip-types", "--no-warnings", join(here, "fixtures", "settle-exit.mjs"), repo,
  ], { env: { ...process.env, ...graftEnv(log) }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const code = await new Promise((resolve) => {
    const killer = setTimeout(() => { child.kill("SIGKILL"); resolve("still running after 15 s"); }, 15_000);
    child.on("exit", (c) => { clearTimeout(killer); resolve(c); });
  });
  assert.equal(code, 0, out);
  assert.match(out, /handlers done/);
  assert.ok(Date.now() - started < 15_000);
});
