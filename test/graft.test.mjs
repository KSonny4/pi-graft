import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const session = (repo) => JSON.parse(readFileSync(join(repo, "graft", ".cache", "session", "test-session.json"), "utf8"));
function askResult(repo, result) {
  const cache = join(repo, "graft", ".cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "ask.json"), JSON.stringify(result));
}
const hit = (pointer) => ({ title: "Relevant node", pointer, snippet: "Useful code" });
const strong = (pointer) => ({ hits: [hit(pointer)], coverageStrong: 0.2, coverage: 0.2 });
const prompt = (text) => ({ prompt: text, systemPrompt: "unchanged system prompt" });
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

test("relevant retrieval is a hidden message, never a system prompt edit", async () => {
  const { repo } = makeRepo();
  const pi = load();
  const ctx = fakeCtx(repo);
  ctx.getSystemPrompt = () => { throw new Error("system prompt must not be read"); };
  await pi.fire("before_agent_start", prompt("hi"), ctx); // orientation only
  askResult(repo, strong("src/a.ts:1"));
  const out = await pi.fire("before_agent_start", prompt("Explain the relevant node"), ctx);
  assert.deepEqual(Object.keys(out), ["message"]);
  assert.equal(out.message.customType, "graft-retrieval");
  assert.equal(out.message.display, false);
  assert.match(out.message.content, /src\/a\.ts:1/);
  assert.equal(session(repo).lastQuery, "Explain the relevant node");
  assert.deepEqual(session(repo).injectedPointers, ["src/a.ts:1"]);
});

test("weak matches add nothing on every prompt, without a nudge cap", async () => {
  const { repo } = makeRepo();
  const pi = load();
  const ctx = fakeCtx(repo);
  await pi.fire("before_agent_start", prompt("hi"), ctx);
  askResult(repo, { hits: [hit("src/a.ts:1")], coverageStrong: 0.01, coverage: 0.1 });
  for (let i = 0; i < 4; i++) {
    assert.equal(await pi.fire("before_agent_start", prompt(`Weak match prompt ${i}`), ctx), undefined);
    assert.equal(session(repo).lastQuery, `Weak match prompt ${i}`);
    assert.deepEqual(session(repo).injectedPointers, []);
    assert.equal(Object.hasOwn(session(repo), "nudges"), false);
  }
});

test("no hits and already-injected pointers add nothing", async () => {
  const { repo } = makeRepo();
  const pi = load();
  const ctx = fakeCtx(repo);
  await pi.fire("before_agent_start", prompt("hi"), ctx);
  askResult(repo, { hits: [] });
  assert.equal(await pi.fire("before_agent_start", prompt("Find a missing symbol"), ctx), undefined);
  askResult(repo, strong("src/a.ts:1"));
  assert.ok((await pi.fire("before_agent_start", prompt("Find this first symbol"), ctx)).message);
  assert.equal(await pi.fire("before_agent_start", prompt("Find this same symbol again"), ctx), undefined);
  assert.equal(session(repo).lastQuery, "Find this same symbol again");
});

test("first prompt combines orientation and relevant retrieval in one message", async () => {
  const { repo } = makeRepo();
  const pi = load();
  askResult(repo, strong("src/a.ts:1"));
  const out = await pi.fire("before_agent_start", prompt("Explain the relevant node"), fakeCtx(repo));
  assert.deepEqual(Object.keys(out), ["message"]);
  assert.equal(out.message.customType, "graft-orientation");
  assert.equal(out.message.display, false);
  assert.match(out.message.content, /repo map \(graft\/INDEX\.md\):\n# graft — repo map\n\n\[graft\] starting points/);
  assert.match(out.message.content, /src\/a\.ts:1/);
});

test("first prompt with weak retrieval has orientation only", async () => {
  const { repo } = makeRepo();
  const pi = load();
  askResult(repo, { hits: [hit("src/a.ts:1")], coverageStrong: 0, coverage: 0 });
  const out = await pi.fire("before_agent_start", prompt("Explain the missing node"), fakeCtx(repo));
  assert.deepEqual(Object.keys(out), ["message"]);
  assert.equal(out.message.customType, "graft-orientation");
  assert.doesNotMatch(out.message.content, /starting points|no strong match/);
});

test("different retrieval on consecutive prompts keeps the system prompt identical", async () => {
  const { repo } = makeRepo();
  const pi = load();
  const ctx = fakeCtx(repo);
  await pi.fire("before_agent_start", prompt("hi"), ctx);
  const systemPrompt = "unchanged system prompt";
  for (const [text, pointer] of [
    ["Explain the first node", "src/a.ts:1"],
    ["Explain the second node", "src/b.ts:2"],
  ]) {
    askResult(repo, strong(pointer));
    const out = await pi.fire("before_agent_start", prompt(text), ctx);
    assert.deepEqual(Object.keys(out), ["message"]);
    assert.equal(out.message.customType, "graft-retrieval");
    assert.match(out.message.content, new RegExp(pointer.replaceAll(".", "\\.")));
    assert.equal(prompt(text).systemPrompt, systemPrompt);
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
