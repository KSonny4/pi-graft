/**
 * pi-graft — Graft context graph for the pi harness, at Claude-Code parity.
 *
 * Claude Code's deep integration (see graft's src/claude/) is five hooks plus
 * a statusline, a skill, and an MCP server. This extension mirrors each one
 * with the pi primitive that matches it closest:
 *
 * | Claude Code                          | pi equivalent here                                   |
 * |--------------------------------------|------------------------------------------------------|
 * | SessionStart hook (orientation:      | `before_agent_start`, once per session: injects the |
 * | directive + INDEX.md slice + stale   | same orientation as a persistent message             |
 * | banner)                              |                                                      |
 * | UserPromptSubmit hook (gated         | `before_agent_start`, every user prompt: runs        |
 * | `graft ask --json -n 3`, strength +  | `graft ask --json -n 3` through the same strength    |
 * | novelty gates, scope hint; pointers- | + novelty gates (+ scope hint) and appends the pack  |
 * | only pack as additionalContext)      | to that turn's system prompt                         |
 * | PostToolUse edit hook (dirty mark +  | `tool_result` on edit/write: marks the shared       |
 * | stale count + blast radius inline)   | stats cache dirty, refreshes the stale count, and    |
 * |                                      | appends the blast radius to the tool result          |
 * | PostToolUse savings hook (graft vs   | `tool_result` on every tool: classifies graft vs     |
 * | source tally, saved-tokens footer    | source use, sums `[graft] tokens saved ≈ N` footers  |
 * | accumulator)                         | into the shared session file                         |
 * | Stop hook (tally check + detached    | `turn_end` (tally check on the reply) +              |
 * | structural rebuild)                  | `agent_settled` (detached structural rebuild)        |
 * | statusline (nodes/edges, freshness,  | `ctx.ui.setStatus("graft", …)` from the same cache  |
 * | tok saved, last file)                |                                                      |
 * | MCP server (6 tools)                 | 6 CLI-backed tools with the same names (pi ships no |
 * |                                      | built-in MCP client)                                 |
 * | skill file                           | bundled skill (same guidance, pi tool names)         |
 *
 * Shared-state discipline (this is what makes it the SAME integration, not a
 * lookalike): stats live in `graft/.cache/stats.json` and per-session counters
 * in `graft/.cache/session/<id>.json`, using graft's own schema, so `graft
 * stats`, a Claude session, and a pi session in the same repo all read and
 * update the same numbers. Writes are atomic (scratch file + rename) and every
 * hook is fail-soft: a graft failure must never fail the turn.
 *
 * MONEY GUARD: the background sync runs plain `graft build` only —
 * structural, $0, offline. Never `--deep` (that calls the LLM on your key).
 *
 * Requires: `graft` on PATH (`npm install -g @nanonets/graft`) and a built
 * graph (`graft build` in the repo; `graft build --deep` for concept nodes).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

// ── constants (mirror graft's own floors/caps) ─────────────────────────────

const GRAFT_BIN = process.env.GRAFT_BIN ?? "graft";
const TOOL_TIMEOUT_MS = Number(process.env.GRAFT_TIMEOUT_MS ?? 30_000);
/** Prompt-hook ask budget: the 8s hook budget minus headroom for our own work. */
const ASK_TIMEOUT_MS = 6_000;
const CHECK_TIMEOUT_MS = 8_000;
/** Background structural rebuild budget (mirrors graft's sync-run). */
const BUILD_TIMEOUT_MS = 120_000;
/** Prompts shorter than this never trigger retrieval (conversational noise). */
const MIN_PROMPT_CHARS = 12;
/** Strength gate, same two-clause rule as graft's fuse ranking. */
const STRONG_FLOOR = 0.1;
const HIGH_FLOOR = 0.5;
/** Novelty gate memory + weak-nudge budget, same as the Claude hooks. */
const INJECTED_POINTERS_CAP = 40;
const NUDGE_CAP = 2;

const SAVINGS_RE = /\[graft\] tokens saved ≈ ([\d,]+)/g;
/** Anchored on "graft saved" + number + tokens so prose about graft can't trip it. */
const TALLY_RE = /graft\s+saved\s*[~≈]?\s*[\d,.]+\s*[km]?\s*(?:tok|tokens)/i;

// ── subprocesses ───────────────────────────────────────────────────────────

function runGraftAsync(args: string[], cwd: string, timeout = TOOL_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      GRAFT_BIN,
      args,
      { cwd, timeout, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const out = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim();
          reject(new Error(out || err.message));
          return;
        }
        resolve(String(stdout ?? ""));
      },
    );
  });
}

/** Synchronous JSON call for turn-blocking hooks. Returns null on any failure
 *  (timeout, no graph, unparseable) — hooks stay silent rather than failing. */
function graftJson(dir: string, args: string[], timeout: number): any | null {
  try {
    const full = withContextDirArg(dir, args);
    const out = execFileSync(GRAFT_BIN, full, {
      cwd: dir, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out);
  } catch (e: any) {
    // `graft check` exits non-zero on drift by design but still prints valid
    // JSON — recover it before giving up.
    const stdout = typeof e?.stdout === "string" ? e.stdout.trim() : "";
    if (stdout) {
      try { return JSON.parse(stdout); } catch { /* fall through */ }
    }
    return null;
  }
}

// ── graft paths (mirror util/state resolveContextDir/cacheDir) ──────────────

function contextDir(projectDir: string): string {
  const override = process.env.GRAFT_DIR;
  if (!override) return join(projectDir, "graft");
  return isAbsolute(override) ? override : join(projectDir, override);
}

function withContextDirArg(dir: string, args: string[]): string[] {
  return process.env.GRAFT_DIR ? [...args, "--dir", contextDir(dir)] : args;
}

const cacheDir = (d: string) => join(contextDir(d), ".cache");
const statsPath = (d: string) => join(cacheDir(d), "stats.json");
const wiringPath = (d: string) => join(contextDir(d), ".graph", "wiring.json");
const indexPath = (d: string) => join(contextDir(d), "INDEX.md");
const sessionPath = (d: string, id: string) =>
  join(cacheDir(d), "session", `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

const hasGraph = (d: string) => existsSync(contextDir(d));

// ── shared state (graft's own schema, atomic writes) ────────────────────────

interface Stats {
  nodeCount: number; edgeCount: number; languages: string[];
  totalCount: number; readyCount: number;
  staleCount: number; dirty: boolean; syncing: boolean;
  syncedAt: string | null; lastFile: string | null;
  /** When the in-flight background sync started (null when idle). A syncing
   *  flag older than BUILD_TIMEOUT_MS is orphaned (pi quit / crash / sleep
   *  killed the detached build) and must be treated as not-syncing. */
  syncStartedAt?: string | null;
}

interface SessionState {
  lastQuery: string | null;
  perAgentQuery: Record<string, string>;
  graftReads: number; sourceReads: number;
  savedTokens: number;
  injectedPointers?: string[];
  nudges?: number;
  graftTurns?: number;
  reportedTurns?: number;
  turnUsedGraft?: boolean;
  lastTallyUuid?: string;
}

function emptyStats(): Stats {
  return {
    nodeCount: 0, edgeCount: 0, languages: [], totalCount: 0, readyCount: 0,
    staleCount: 0, dirty: false, syncing: false, syncedAt: null, lastFile: null,
    syncStartedAt: null,
  };
}

function emptySession(): SessionState {
  return {
    lastQuery: null, perAgentQuery: {}, graftReads: 0, sourceReads: 0,
    savedTokens: 0, injectedPointers: [], nudges: 0,
  };
}

function readJson<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; }
}

function writeJsonAtomic(p: string, value: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, p);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw new Error(`write ${p} failed`);
  }
}

function readStats(d: string): Stats | null {
  return readJson<Stats>(statsPath(d));
}

function patchStats(d: string, patch: Partial<Stats>): Stats {
  const next: Stats = { ...(readStats(d) ?? emptyStats()), ...patch };
  writeJsonAtomic(statsPath(d), next);
  return next;
}

/** True when the syncing flag is orphaned: set, but its build can no longer
 *  be alive (older than the rebuild budget, or timestamp missing from an
 *  older version). Callers should clear it instead of showing `syncing…`. */
function isSyncStale(s: Stats | null): boolean {
  if (!s?.syncing) return false;
  if (!s.syncStartedAt) return true;
  const age = Date.now() - Date.parse(s.syncStartedAt);
  return Number.isNaN(age) || age > BUILD_TIMEOUT_MS;
}

/** Clear an orphaned syncing flag (persisted so every session sees it). */
function healStaleSync(d: string): Stats | null {
  const s = readStats(d);
  if (!isSyncStale(s)) return s;
  return patchStats(d, { syncing: false, syncStartedAt: null });
}

function readSession(d: string, id: string): SessionState {
  return readJson<SessionState>(sessionPath(d, id)) ?? emptySession();
}

function writeSession(d: string, id: string, s: SessionState): void {
  writeJsonAtomic(sessionPath(d, id), s);
}

// ── wiring graph (pure reads — the fast path behind blast radius/status) ────

interface WiringNode { id: string; name: string; kind: string; path?: string; summary_state?: string }
interface WiringEdge { source: string; target: string; relation: string }
interface Wiring { meta?: { nodeCount?: number; edgeCount?: number; languages?: string[]; scopes?: { prefix: string }[] }; nodes?: WiringNode[]; edges?: WiringEdge[] }

function readWiring(d: string): Wiring | null {
  return readJson<Wiring>(wiringPath(d));
}

/** Statusline fast path: hook-maintained cache first, wiring graph as fallback
 *  (a fresh `graft build` doesn't write the cache), null only when unbuilt. */
function resolveStats(d: string): Stats | null {
  const cached = readStats(d);
  if (cached && cached.nodeCount > 0) return cached;
  const w = readWiring(d);
  if (!w) return null;
  const nodes = w.nodes ?? [];
  const edges = w.edges ?? [];
  return {
    ...emptyStats(),
    nodeCount: w.meta?.nodeCount ?? nodes.length,
    edgeCount: w.meta?.edgeCount ?? edges.length,
    languages: w.meta?.languages ?? [],
    totalCount: nodes.length,
    readyCount: nodes.filter((n) => n.summary_state === "ready").length,
  };
}

// ── formatting (mirror claude/format) ───────────────────────────────────────

function freshnessSegment(s: Stats): string {
  if (s.syncing && !isSyncStale(s)) return "syncing…";
  if (s.dirty && s.staleCount > 0) return `⚠ ${s.staleCount} stale`;
  if (s.dirty) return "⚠ stale";
  return "✓ synced";
}

/** One footer line: `◤ graft · N nodes / M edges · ✓ synced · ~N tok saved`.
 *  (pi's own footer already shows context usage, so no ctx% line — unlike the
 *  two-line Claude bar. Dollar figures need per-turn billing only the Claude
 *  transcript exposes, so pi shows tokens alone rather than pricing them.) */
function renderStatusline(stats: Stats | null, session: SessionState | null): string {
  if (!stats) return "◤ graft · not built · run graft build";
  const parts = [`◤ graft`, `${stats.nodeCount} nodes / ${stats.edgeCount} edges`, freshnessSegment(stats)];
  const saved = session?.savedTokens ?? 0;
  if (saved > 0) parts.push(`~${saved.toLocaleString()} tok saved`);
  if (stats.lastFile) parts.push(`last: ${basename(stats.lastFile)}`);
  return parts.join(" · ");
}

/** Blast radius for an edited file: who depends on it (cap 8, like Claude). */
function formatBlastRadius(w: Wiring, filePath: string, cap = 8): string | null {
  const ids = new Set(
    (w.nodes ?? [])
      .filter((n) => n.path && (filePath === n.path || filePath.endsWith(`/${n.path}`)))
      .map((n) => n.id),
  );
  if (!ids.size) return null;
  const incoming = (w.edges ?? []).filter((e) => ids.has(e.target) && !ids.has(e.source));
  if (!incoming.length) return null;
  const byId = new Map((w.nodes ?? []).map((n) => [n.id, n]));
  const items = incoming.slice(0, cap).map((e) => {
    const n = byId.get(e.source);
    const label = n ? `${n.name} (${basename(n.path ?? e.source)})` : e.source;
    return ` • ${e.relation} ← ${label}`;
  });
  const more = incoming.length > cap ? `\n • +${incoming.length - cap} more` : "";
  return `[graft] blast radius for ${basename(filePath)}, who depends on it:\n${items.join("\n")}${more}`;
}

interface AskHit { title: string; pointer: string; snippet?: string; code?: string }
interface AskJson {
  hits: AskHit[];
  saved?: { files: number; baselineChars: number };
  coverage?: number;
  coverageStrong?: number;
}

const tokensOf = (chars: number) => Math.round(chars / 4);

function retrievalBody(hits: AskHit[]): string {
  const blocks = hits.map((h, i) => {
    const ptr = (h.pointer ?? "").split(",")[0].trim();
    const snip = (h.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
    let b = ` ${i + 1}. ${h.title}: ${ptr}`;
    if (snip) b += `\n    ${snip}`;
    if (h.code) b += `\n\`\`\`\n${h.code}\n\`\`\``;
    return b;
  });
  // Pointers-only pack (the prompt hook never passes --source: per-prompt
  // injected tokens are fresh full-price input, so the pack stays tiny and the
  // agent pulls spans itself via the find-code tool when a pointer looks right).
  const header = hits.some((h) => h.code)
    ? "[graft] retrieved context, read these spans; do not re-open the files:"
    : "[graft] starting points for this task: pull the code inline with graft_find_code (or `graft ask \"<what you need>\" --source`), trace impact with graft_trace_calls, or search with graft_find_all:";
  return `${header}\n${blocks.join("\n")}`;
}

function retrievalTokensSaved(ask: AskJson, cap = 3): number {
  const hits = (ask.hits ?? []).slice(0, cap);
  if (!hits.length || !ask.saved || ask.saved.baselineChars <= 0) return 0;
  const pack = tokensOf(retrievalBody(hits).length);
  const base = tokensOf(ask.saved.baselineChars);
  return base > pack ? base - pack : 0;
}

function formatRetrieval(ask: AskJson, cap = 3): string | null {
  const hits = (ask.hits ?? []).slice(0, cap);
  if (!hits.length) return null;
  const body = retrievalBody(hits);
  const saved = retrievalTokensSaved(ask, cap);
  if (saved <= 0) return body;
  const base = tokensOf(ask.saved!.baselineChars);
  const pct = Math.round((saved / base) * 100);
  return (
    `${body}\n[graft] tokens saved ≈ ${saved.toLocaleString()} (${pct}%); this pack ≈ ` +
    `${tokensOf(body.length).toLocaleString()} tok vs reading the ${ask.saved!.files} file(s) whole ≈ ` +
    `${base.toLocaleString()} tok (estimate).`
  );
}

function weakMatchNudge(s: SessionState, strong: number): string | null {
  const spent = s.nudges ?? 0;
  if (spent >= NUDGE_CAP) return null;
  s.nudges = spent + 1;
  return (
    `[graft] no strong match for this prompt (name-field match ${strong.toFixed(2)}) — the graph ` +
    `has more than this probe found. Run graft_find_code (or \`graft ask "<your task>" --source\`) before grepping.`
  );
}

/** Per-prompt injection gate: strength first, novelty second. Mutates `s`
 *  (injected pointers, nudges); the caller persists it. */
function relevantRetrieval(ask: AskJson, s: SessionState, cap = 3): string | null {
  if (!(ask.hits ?? []).length) return null;
  const lexical = typeof ask.coverage === "number" || typeof ask.coverageStrong === "number";
  if (lexical) {
    const strong = ask.coverageStrong ?? 0;
    const broad = ask.coverage ?? 0;
    if (strong < STRONG_FLOOR && broad < HIGH_FLOOR) return weakMatchNudge(s, strong);
  }
  const seen = new Set(s.injectedPointers ?? []);
  const fresh = ask.hits.filter((h) => !seen.has(h.pointer));
  if (!fresh.length) return null;
  const txt = formatRetrieval({ ...ask, hits: fresh }, cap);
  if (!txt) return null;
  s.injectedPointers = [...(s.injectedPointers ?? []), ...fresh.slice(0, cap).map((h) => h.pointer)]
    .slice(-INJECTED_POINTERS_CAP);
  return txt;
}

function staleNote(d: string): string {
  try {
    const s = readStats(d);
    if (s?.dirty && (s.staleCount ?? 0) > 0) {
      return `⚠ ${s.staleCount} file(s) changed since the graph was built — answers may miss them. \`graft build\` refreshes (structural, $0).`;
    }
  } catch { /* ignore */ }
  return "";
}

/** Session orientation: always-on directive (the reliable steering channel —
 *  it fires every session, unlike the discretionary skill) + INDEX.md slice. */
function formatOrientation(indexMd: string, stale: string): string {
  const directive =
    `[graft] This repo is indexed by graft. To find, understand, or change code, reach for graft first; it answers from a prebuilt graph with exact file:line, faster than grep/read. Pick the ONE tool that fits and act on its answer. Most tasks need a single call. If one isn't enough, switch to the tool that fits the next need; don't call the same tool again and again or re-ask a question reworded:\n` +
    `  • graft_find_code (or \`graft ask "<task>" --source\`): locate + understand. Ranked nodes with the code inlined at each file:line (the ≤8-line crux; add full:true / --full for the whole span). The default for "how does X work" / "where is Y".\n` +
    `  • graft_find_all (or \`graft grep "<literal>"\`): exhaustive find. Every occurrence, grouped by enclosing symbol; use when you need them ALL (find-code is ranked top-N and misses instances).\n` +
    `  • graft_file_api (or \`graft skeleton <file>\`): a file's whole API in ~200 tokens, every signature + span, ~10x cheaper than reading the file.\n` +
    `  • graft_trace_calls (or \`graft callers <sym> [--direction out] [--depth N|all]\`): exact edges. Who calls it (default), what it calls (out), or the full blast radius (--depth 2, or all for every connected source). Run before you change a symbol.\n` +
    `  • graft_repo_map (or \`graft map\`): orientation for an unfamiliar repo, directory clusters, hubs, hotspots. map alone is the answer; don't then skeleton every subsystem it names.\n` +
    `  In a monorepo, add in:<path>/ to find-code / find-all / trace-calls to scope to one sub-project; hits are labeled [scope/].\n` +
    `  Already know the file or symbol to change? Go straight to it: graft_find_all for "<symbol>", read the span, edit. Save find-code for when you don't yet know where the code lives.\n` +
    `  Refactor, rename, or multi-file change? Run graft_trace_calls with depth all FIRST to map every connected file; editing the primary file and stopping is the classic miss.\n` +
    `Each tool opens its output with a "[graft] tokens saved ≈ N" line; when you used graft this turn, close your reply with a one-line tally of the total saved (e.g. 🌱 graft saved ~12k tokens this turn, 3 calls). Never pipe graft output through head/tail — it is already capped, and clipping drops that line.\n`;
  const banner = stale ? `${stale}\n\n` : "";
  return `${banner}${directive}\nrepo map (graft/INDEX.md):\n${indexMd.slice(0, 1500)}`;
}

/** Multi-scope hint: narrow the prompt ask to the scope holding the last-edited
 *  file. Best-effort — single-scope graphs, unknown files, and ambiguous
 *  basenames all skip silently. */
function lastFileScopeHint(d: string, lastFile: string | null | undefined): string | null {
  if (!lastFile) return null;
  try {
    const w = readWiring(d);
    if (!w) return null;
    const scopes = w.meta?.scopes ?? [];
    if (scopes.length <= 1) return null;
    const base = basename(lastFile);
    const matches = (w.nodes ?? []).filter(
      (n) => n.path && (n.path === base || n.path.endsWith(`/${base}`)),
    );
    if (!matches.length) return null;
    const prefixes = new Set(
      matches.map((n) => {
        const sorted = [...scopes].sort((a, b) => b.prefix.length - a.prefix.length);
        return sorted.find((s) => s.prefix === "" || n.path === s.prefix || n.path!.startsWith(`${s.prefix}/`))?.prefix ?? "";
      }),
    );
    if (prefixes.size > 1) return null;
    const [prefix] = prefixes;
    return prefix === "" ? null : prefix;
  } catch {
    return null;
  }
}

// ── tool-use classification + savings (mirror session-metrics) ──────────────

const SOURCE_TOOLS = new Set(["read", "grep", "glob", "find", "ls", "search"]);

function classifyToolUse(toolName: string, command?: string): "graft" | "source" | null {
  const name = (toolName ?? "").toLowerCase();
  if (name.startsWith("graft_")) return "graft";
  if (name === "bash" || name === "powershell") {
    if (command && /(^|[\s;&|])(sudo\s+)?graft[\s]/.test(` ${command} `)) return "graft";
    return null;
  }
  if (SOURCE_TOOLS.has(name)) return "source";
  return null;
}

function sumSavingsFooters(text: string): number {
  let total = 0;
  for (const m of text.matchAll(SAVINGS_RE)) total += Number(m[1].replace(/,/g, "")) || 0;
  return total;
}

function assistantText(message: any): string {
  const c = message?.content ?? message?.text ?? "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((b) => (typeof b === "string" ? b : (b?.text ?? ""))).join("\n");
  }
  return "";
}

/** Edited-file path across pi edit-tool shapes; null when not an edit. */
function editedFilePath(toolName: string, input: any): string | null {
  const name = (toolName ?? "").toLowerCase();
  if (name !== "edit" && name !== "write") return null;
  const p = input?.path ?? input?.file ?? input?.file_path ?? input?.filename;
  return typeof p === "string" && p.trim() ? p : null;
}

function underGraft(d: string, file: string): boolean {
  const abs = isAbsolute(file) ? file : join(d, file);
  const ctx = contextDir(d);
  return abs === ctx || abs.startsWith(`${ctx}/`);
}

function toolText(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
  };
}

function graftErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/no graph|graft build/i.test(msg)) {
    return `${msg}\n\nNo graft/ graph here yet. Run \`graft build\` (or \`graft init --agents agents && graft build\`) in the repo root, then retry.`;
  }
  if (/ENOENT|not found|command not found/i.test(msg)) {
    return `graft CLI not found on PATH. Install it once with \`npm install -g @nanonets/graft\`, then run \`graft build\` in this repo.\n\nUnderlying error: ${msg}`;
  }
  return msg;
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const versionCache = new Map<string, string | null>();
  /** Sessions already given the orientation message (reset on session_start). */
  const oriented = new Set<string>();
  /** Working dirs with a background sync in flight. */
  const syncing = new Set<string>();

  async function graftVersion(cwd: string): Promise<string | null> {
    if (!versionCache.has(cwd)) {
      try {
        const out = await runGraftAsync(["--version"], cwd, 5_000);
        versionCache.set(cwd, out.trim().slice(0, 40) || "unknown");
      } catch {
        versionCache.set(cwd, null);
      }
    }
    return versionCache.get(cwd) ?? null;
  }

  async function refreshStatus(ctx: ExtensionContext, cwd: string) {
    try {
      const version = await graftVersion(cwd);
      if (!version) {
        ctx.ui.setStatus("graft", "graft: not installed (npm i -g @nanonets/graft)");
        return;
      }
      // Self-heal here (not just at settle): a restarted session must not
      // display another process's orphaned `syncing…` for even one turn.
      healStaleSync(cwd);
      const stats = resolveStats(cwd);
      if (!stats) {
        ctx.ui.setStatus("graft", `graft ${version}: no graph — run graft build`);
        return;
      }
      let session: SessionState | null = null;
      try { session = readSession(cwd, ctx.sessionManager.getSessionId()); } catch { /* ignore */ }
      ctx.ui.setStatus("graft", `graft ${version}: ${renderStatusline(stats, session)}`);
    } catch { /* status must never fail the turn */ }
  }

  function sid(ctx: ExtensionContext): string {
    try { return ctx.sessionManager.getSessionId() ?? "default"; }
    catch { return "default"; }
  }

  /**
   * Snapshot the cwd synchronously at handler entry. The ctx object is
   * invalidated after session teardown (newSession/fork/switchSession/
   * reload/-p exit) and ANY later touch — even the `cwd` getter — throws a
   * stale-ctx error. Returns null when the session is already gone; callers
   * must bail out silently (hooks) or fail soft (tools/commands). Downstream
   * ctx uses (refreshStatus, notify) stay inside try/catch so a session that
   * dies mid-flight can never fail the turn.
   */
  function snapCwd(ctx: ExtensionContext): string | null {
    try {
      const c = ctx.cwd;
      return typeof c === "string" && c.length > 0 ? c : null;
    } catch { return null; }
  }

  pi.on("session_start", async (_event, ctx) => {
    const cwd = snapCwd(ctx);
    if (!cwd) return;
    try { oriented.delete(`${sid(ctx)}@${cwd}`); } catch { /* ignore */ }
    await refreshStatus(ctx, cwd);
  });

  // SessionStart + UserPromptSubmit hooks, combined: orientation once per
  // session (persistent message), gated retrieval pack every prompt (this
  // turn's system prompt — per-turn context, never persisted history).
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = snapCwd(ctx);
    if (!cwd) return;
    if (!hasGraph(cwd)) return;
    const out: { message?: any; systemPrompt?: string } = {};

    // 1 · orientation (once per session).
    const okey = `${sid(ctx)}@${cwd}`;
    if (!oriented.has(okey)) {
      oriented.add(okey);
      try {
        const idx = readFileSync(indexPath(cwd), "utf8");
        out.message = {
          customType: "graft-orientation",
          content: formatOrientation(idx, staleNote(cwd)),
          display: false,
        };
      } catch {
        // No INDEX.md (never built here) — nothing to orient with.
      }
    }

    // 2 · per-prompt retrieval (pointers only, gated).
    try {
      const prompt = String((event as any)?.prompt ?? "").trim();
      if (prompt.length >= MIN_PROMPT_CHARS) {
        const askArgs = ["ask", prompt, ".", "--json", "-n", "3"];
        const stats = readStats(cwd);
        const scopeHint = lastFileScopeHint(cwd, stats?.lastFile);
        if (scopeHint) askArgs.push("--in", scopeHint);
        const ask = graftJson(cwd, askArgs, ASK_TIMEOUT_MS) as AskJson | null;
        if (ask) {
          const id = sid(ctx);
          const s = readSession(cwd, id);
          s.lastQuery = prompt;
          const txt = relevantRetrieval(ask, s);
          writeSession(cwd, id, s);
          if (txt) {
            const base = (event as any)?.systemPrompt ?? ctx.getSystemPrompt();
            out.systemPrompt = `${base}\n\n${txt}`;
          }
        }
      }
    } catch { /* retrieval is advisory — never fail the turn */ }

    if (out.message || out.systemPrompt) return out;
  });

  // PostToolUse savings hook (every tool) + post-edit hook (edit/write):
  // shared counters, dirty marking, and inline blast radius.
  pi.on("tool_result", async (event, ctx) => {
    const cwd = snapCwd(ctx);
    if (!cwd) return;
    if (!hasGraph(cwd)) return;
    const ev = event as any;
    const toolName: string = ev?.toolName ?? "";
    const input: any = ev?.input;
    let patch: { content?: any; details?: any } | undefined;

    // 1 · savings tally (all tools — the no-write path keeps it cheap).
    try {
      const command = typeof input?.command === "string" ? input.command : undefined;
      let kind = classifyToolUse(toolName, command);
      const saved = sumSavingsFooters(JSON.stringify(ev?.content ?? ""));
      if (saved > 0 && kind !== "graft") kind = "graft"; // footer proves graft ran
      if (kind || saved > 0) {
        const id = sid(ctx);
        const s = readSession(cwd, id);
        if (kind === "graft") { s.graftReads = (s.graftReads ?? 0) + 1; s.turnUsedGraft = true; }
        else if (kind === "source") s.sourceReads = (s.sourceReads ?? 0) + 1;
        else if (saved > 0) s.turnUsedGraft = true;
        s.savedTokens = (s.savedTokens ?? 0) + saved;
        writeSession(cwd, id, s);
        if (saved > 0) await refreshStatus(ctx, cwd);
      }
    } catch { /* tally must never fail the turn */ }

    // 2 · post-edit: blast radius inline + dirty marking (edits only).
    try {
      if (ev?.isError) return patch;
      const rel = editedFilePath(toolName, input);
      if (!rel) return patch;
      const abs = isAbsolute(rel) ? rel : join(cwd, rel);
      if (underGraft(cwd, abs)) return patch;
      const w = readWiring(cwd);
      if (w) {
        const br = formatBlastRadius(w, abs);
        if (br) {
          const content = Array.isArray(ev?.content)
            ? [...ev.content, { type: "text", text: br }]
            : [{ type: "text", text: String(ev?.content ?? "") }, { type: "text", text: br }];
          patch = { ...patch, content };
        }
      }
      // Mark dirty + refresh the stale count (pure drift report, no rebuild).
      const check = graftJson(cwd, ["check", ".", "--json"], CHECK_TIMEOUT_MS) as any;
      const g = check?.graph ?? {};
      const staleCount =
        (g.changed?.length ?? 0) + (g.added?.length ?? 0) + (g.removed?.length ?? 0);
      patchStats(cwd, { dirty: true, staleCount, lastFile: basename(abs) });
      // A stale syncing flag from a killed build must not survive an edit:
      // the footer should show the real ⚠ stale state, not phantom syncing.
      healStaleSync(cwd);
      await refreshStatus(ctx, cwd);
    } catch { /* post-edit work is advisory */ }

    return patch;
  });

  // Stop hook, part 1: did the reply the user just read say what graft saved?
  // Only runs on turns the savings hook flagged, and duplicate ends can't
  // double-count (lastTallyUuid), mirroring graft's tally.
  pi.on("turn_end", async (event, ctx) => {
    const cwd = snapCwd(ctx);
    if (!cwd) return;
    if (!hasGraph(cwd)) return;
    try {
      const id = sid(ctx);
      const s = readSession(cwd, id);
      if (!s.turnUsedGraft) return;
      const ev = event as any;
      const text = assistantText(ev?.message);
      const uuid = String(ev?.message?.uuid ?? ev?.message?.id ?? ev?.turnIndex ?? "");
      if (!text || uuid === (s.lastTallyUuid ?? "")) {
        s.turnUsedGraft = false;
        writeSession(cwd, id, s);
        return;
      }
      s.graftTurns = (s.graftTurns ?? 0) + 1;
      if (TALLY_RE.test(text)) s.reportedTurns = (s.reportedTurns ?? 0) + 1;
      s.turnUsedGraft = false;
      s.lastTallyUuid = uuid;
      writeSession(cwd, id, s);
    } catch { /* metrics must never fail the turn */ }
  });

  // Stop hook, part 2: background structural rebuild at settle (never --deep).
  // Detached so it survives `-p` exits; the completion is recorded in the
  // shared stats cache, which the next status refresh picks up.
  pi.on("agent_settled", async (_event, ctx) => {
    // Snapshot first: after settle the session may already be torn down and
    // even reading ctx.cwd throws (stale-ctx). refreshStatus below is
    // internally guarded, so a death mid-flight stays silent too.
    const cwd = snapCwd(ctx);
    if (!cwd) return;
    if (!hasGraph(cwd) || syncing.has(cwd)) return;
    // Orphaned flag from a previous process that died mid-build: clear it so
    // the footer is truthful even when this turn makes no edits (!dirty).
    healStaleSync(cwd);
    let stats: Stats | null = null;
    try { stats = readStats(cwd); } catch { return; }
    if (!stats?.dirty) return;
    syncing.add(cwd);
    try { patchStats(cwd, { syncing: true, syncStartedAt: new Date().toISOString() }); } catch { /* ignore */ }
    await refreshStatus(ctx, cwd);
    const dir = cwd;
    const bin = GRAFT_BIN;
    const syncScript = `
const {execFileSync} = require("node:child_process");
const {readFileSync, writeFileSync, mkdirSync, renameSync, existsSync} = require("node:fs");
const {join, dirname} = require("node:path");
const [dir, bin] = process.argv.slice(-2);
const ctxDir = process.env.GRAFT_DIR
  ? (process.env.GRAFT_DIR.startsWith("/") ? process.env.GRAFT_DIR : join(dir, process.env.GRAFT_DIR))
  : join(dir, "graft");
const statsP = join(ctxDir, ".cache", "stats.json");
const wiringP = join(ctxDir, ".graph", "wiring.json");
const readJ = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const writeAtomic = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + "." + process.pid + ".tmp";
  try { writeFileSync(tmp, JSON.stringify(v)); renameSync(tmp, p); }
  catch { try { require("node:fs").rmSync(tmp, { force: true }); } catch {} }
};
try {
  execFileSync(bin, ["build", "."], { cwd: dir, stdio: "ignore", timeout: ${BUILD_TIMEOUT_MS} });
  const w = readJ(wiringP);
  if (!w) { writeAtomic(statsP, { ...(readJ(statsP) ?? {}), syncing: false, syncStartedAt: null }); process.exit(0); }
  const nodes = w.nodes ?? [], edges = w.edges ?? [];
  writeAtomic(statsP, {
    ...(readJ(statsP) ?? {}),
    dirty: false, staleCount: 0, syncing: false, syncStartedAt: null, syncedAt: new Date().toISOString(),
    nodeCount: (w.meta && w.meta.nodeCount) || nodes.length,
    edgeCount: (w.meta && w.meta.edgeCount) || edges.length,
    languages: (w.meta && w.meta.languages) || [],
    totalCount: nodes.length,
    readyCount: nodes.filter((n) => n.summary_state === "ready").length,
  });
} catch {
  try { writeAtomic(statsP, { ...(readJ(statsP) ?? {}), syncing: false, syncStartedAt: null }); } catch {}
}
`;
    try {
      const child = spawn(process.execPath, ["-e", syncScript, dir, bin], {
        cwd: dir, detached: true, stdio: "ignore", windowsHide: true,
      });
      child.unref();
    } catch { /* best-effort; the next query refreshes anyway */ }
    // Reconcile locally: the detached run owns completion, this only clears
    // our in-flight guard after a grace period (next settle retries if dirty).
    // unref: the guard must never keep `pi -p` alive for the whole grace
    // period after the session has finished.
    setTimeout(() => { syncing.delete(dir); }, BUILD_TIMEOUT_MS).unref();
  });

  // ── the six tools (MCP names, CLI-backed — pi has no MCP client) ──────────

  pi.registerTool({
    name: "graft_find_code",
    label: "Graft find code",
    description:
      "Query the repo context graph in plain words. Returns ranked nodes with exact file:line spans and the relevant source inlined — usually the full answer, no file reads needed. Use for understanding or locating code; for exhaustive 'every occurrence' tasks use graft_find_all instead.",
    promptSnippet: "graft_find_code: conceptual/locational code search over graft/ (ranked, top-N)",
    promptGuidelines: [
      "For 'how does X work / where is Y' questions, call graft_find_code first — one call usually answers.",
      "The top node IS the answer for understanding/editing: cite its covers: file:line spans and edit straight from --source output.",
      "Never pipe graft_find_code output through head/tail/sed — it is already capped and carries the savings line.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "what you want to understand, in plain words" }),
      limit: Type.Optional(Type.Number({ description: "max results (default 8)" })),
      full: Type.Optional(Type.Boolean({ description: "inline whole definitions instead of ≤8-line crux excerpts" })),
      in: Type.Optional(Type.String({ description: "narrow to nodes under this path prefix, e.g. server/src" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = snapCwd(ctx);
      if (!cwd) throw new Error("session ended before the tool could run; retry the call");
      const args = ["ask", params.query, "--source"];
      if (params.full) args.push("--full");
      if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
        args.push("-n", String(Math.max(1, Math.floor(params.limit))));
      }
      if (params.in) args.push("--in", params.in);
      try {
        const stdout = await runGraftAsync(withContextDirArg(ctx.cwd, args), ctx.cwd);
        return toolText(stdout.trim() || "(no hits — loosen the question or try graft_find_all)");
      } catch (err) {
        throw new Error(graftErrorText(err));
      }
    },
  });

  pi.registerTool({
    name: "graft_find_all",
    label: "Graft find all",
    description:
      "Exhaustive regex/literal search over graft's indexed files, hits grouped by enclosing symbol and ranked by coupling. Use when you need EVERY occurrence (all call sites, all uses of a constant). For conceptual questions use graft_find_code instead.",
    promptSnippet: "graft_find_all: exhaustive pattern search (complete, not top-N)",
    promptGuidelines: [
      "Search a short symbol name or literal with graft_find_all, not a full signature — over-specific regex returns nothing.",
      "If a graft_find_all search misses, loosen it (drop receiver/signature, keep the bare name) and retry — do not fall back to raw grep except for files graft doesn't index.",
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: "regex pattern (or literal with fixed: true)" }),
      in: Type.Optional(Type.String({ description: "narrow to files at or under this path prefix" })),
      ignore_case: Type.Optional(Type.Boolean({ description: "case-insensitive match" })),
      fixed: Type.Optional(Type.Boolean({ description: "treat pattern as a literal string, not a regex" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = snapCwd(ctx);
      if (!cwd) throw new Error("session ended before the tool could run; retry the call");
      const args = ["grep", params.pattern];
      if (params.in) args.push("--in", params.in);
      if (params.ignore_case) args.push("-i");
      if (params.fixed) args.push("--fixed");
      try {
        const stdout = await runGraftAsync(withContextDirArg(ctx.cwd, args), ctx.cwd);
        return toolText(stdout.trim() || "(no hits)");
      } catch (err) {
        throw new Error(graftErrorText(err));
      }
    },
  });

  pi.registerTool({
    name: "graft_trace_calls",
    label: "Graft trace calls",
    description:
      "Structural call/reference edges for a symbol (not text search). Default = who calls it (in); direction out = what it calls; depth N / all = transitive blast radius. Run before renaming, deleting, changing a signature, or any multi-file refactor.",
    promptSnippet: "graft_trace_calls: exact caller/callee edges + blast radius",
    promptGuidelines: [
      "Before a rename/delete/signature change, call graft_trace_calls with depth 2.",
      "Before a refactor or multi-file change, call graft_trace_calls with depth all — map every connected file, don't stop at the first.",
    ],
    parameters: Type.Object({
      symbol: Type.String({ description: "bare name, Class.method, pkg.Fn, or a file path" }),
      direction: Type.Optional(Type.String({ description: '"in" (callers, default) or "out" (callees)' })),
      depth: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: '1 = direct edges; N = N hops; "all" = full closure' })),
      in: Type.Optional(Type.String({ description: "narrow matches to this path prefix" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = snapCwd(ctx);
      if (!cwd) throw new Error("session ended before the tool could run; retry the call");
      const args = ["callers", params.symbol];
      args.push("--direction", params.direction === "out" ? "out" : "in");
      if (params.depth !== undefined) args.push("--depth", String(params.depth));
      if (params.in) args.push("--in", params.in);
      try {
        const stdout = await runGraftAsync(withContextDirArg(ctx.cwd, args), ctx.cwd);
        return toolText(stdout.trim() || "(no edges — check spelling or run graft build)");
      } catch (err) {
        throw new Error(graftErrorText(err));
      }
    },
  });

  pi.registerTool({
    name: "graft_file_api",
    label: "Graft file API",
    description:
      "Signatures-only view of one file — every definition's signature + line span, ~10x cheaper than reading the file. Use for 'what's in this file / what can I call here' before editing.",
    promptSnippet: "graft_file_api: one file's API surface, signatures only",
    promptGuidelines: ["One graft_file_api call is the whole answer for a file; don't call graft_file_api twice on the same file."],
    parameters: Type.Object({
      file: Type.String({ description: "repo-relative path (or unique basename) of the file" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = snapCwd(ctx);
      if (!cwd) throw new Error("session ended before the tool could run; retry the call");
      try {
        const stdout = await runGraftAsync(withContextDirArg(cwd, ["skeleton", params.file]), cwd);
        return toolText(stdout.trim() || "(empty — file may not be indexed; try graft build)");
      } catch (err) {
        throw new Error(graftErrorText(err));
      }
    },
  });

  pi.registerTool({
    name: "graft_repo_map",
    label: "Graft repo map",
    description:
      "Token-budgeted repo orientation — directory clusters, per-directory hubs, global hotspots from the wiring graph. Use when landing in a repo cold or asked for 'the architecture'. map alone is the answer: read the hub cards it names.",
    promptSnippet: "graft_repo_map: cold-start orientation (clusters, hubs, hotspots)",
    promptGuidelines: [
      "After graft_repo_map, read the named hub cards — do not then skeleton/ask your way through every subsystem it lists.",
    ],
    parameters: Type.Object({
      max_dirs: Type.Optional(Type.Number({ description: "max directory entries shown (default 16)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = snapCwd(ctx);
      if (!cwd) throw new Error("session ended before the tool could run; retry the call");
      const args = ["map"];
      if (typeof params.max_dirs === "number" && Number.isFinite(params.max_dirs)) {
        args.push("--max-dirs", String(Math.max(1, Math.floor(params.max_dirs))));
      }
      try {
        const stdout = await runGraftAsync(withContextDirArg(ctx.cwd, args), ctx.cwd);
        return toolText(stdout.trim() || "(empty map — run graft build)");
      } catch (err) {
        throw new Error(graftErrorText(err));
      }
    },
  });

  pi.registerTool({
    name: "graft_check_freshness",
    label: "Graft freshness",
    description:
      "Report whether the local graft/ graph has drifted from the code. Use to confirm the graph is trustworthy before a big task, or in CI. Does not rebuild — run graft build to refresh.",
    promptSnippet: "graft_check_freshness: drift report for graft/",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const cwd = snapCwd(ctx);
      if (!cwd) throw new Error("session ended before the tool could run; retry the call");
      try {
        const stdout = await runGraftAsync(withContextDirArg(cwd, ["check"]), cwd);
        await refreshStatus(ctx, cwd);
        return toolText(stdout.trim() || "graft check: in sync");
      } catch (err) {
        // `graft check` exits 1 on drift — that output IS the answer.
        const text = graftErrorText(err);
        await refreshStatus(ctx, cwd);
        return toolText(text);
      }
    },
  });

  // ── commands ─────────────────────────────────────────────────────

  pi.registerCommand("graft-build", {
    description: "Build/refresh the graft/ context graph (deterministic, no key)",
    handler: async (args, ctx) => {
      const extra = args.trim() ? args.trim().split(/\s+/) : [];
      const cwd = snapCwd(ctx);
      if (!cwd) return;
      ctx.ui.notify("Running graft build…", "info");
      try {
        const stdout = await runGraftAsync(["build", ...extra], cwd);
        ctx.ui.notify(stdout.trim().split("\n").slice(-3).join("\n") || "graft build done", "info");
      } catch (err) {
        ctx.ui.notify(graftErrorText(err), "error");
      }
      await refreshStatus(ctx, cwd);
    },
  });

  pi.registerCommand("graft-check", {
    description: "Check whether graft/ has drifted from the code",
    handler: async (_args, ctx) => {
      const cwd = snapCwd(ctx);
      if (!cwd) return;
      try {
        const stdout = await runGraftAsync(["check"], cwd);
        ctx.ui.notify(stdout.trim() || "graft check: in sync", "info");
      } catch (err) {
        ctx.ui.notify(graftErrorText(err), "warning");
      }
      await refreshStatus(ctx, cwd);
    },
  });

  pi.registerCommand("graft-map", {
    description: "Show the token-budgeted repo map (orientation)",
    handler: async (_args, ctx) => {
      const cwd = snapCwd(ctx);
      if (!cwd) return;
      try {
        const stdout = await runGraftAsync(["map"], cwd);
        ctx.ui.notify(stdout.trim().slice(0, 4000) || "(empty map)", "info");
      } catch (err) {
        ctx.ui.notify(graftErrorText(err), "error");
      }
    },
  });

  pi.registerCommand("graft-status", {
    description: "Show graft graph stats and this session's tokens-saved tally",
    handler: async (_args, ctx) => {
      const cwd = snapCwd(ctx);
      if (!cwd) return;
      const stats = resolveStats(cwd);
      if (!stats) {
        ctx.ui.notify("graft: no graph — run graft build", "warning");
        return;
      }
      let session: SessionState | null = null;
      try { session = readSession(cwd, sid(ctx)); } catch { /* ignore */ }
      const s = session ?? emptySession();
      ctx.ui.notify(
        `${renderStatusline(stats, session)}\n` +
        `reads: ${s.graftReads ?? 0} graft / ${s.sourceReads ?? 0} source · ` +
        `tally reported on ${s.reportedTurns ?? 0}/${s.graftTurns ?? 0} graft turns`,
        "info",
      );
    },
  });
}
