# pi-graft — Graft support for the pi harness, at Claude-Code parity

Graft (https://github.com/trailhq/Graft) builds a linked-markdown context graph
of your repo so coding agents skip re-exploration: fewer tool calls, fewer
tokens, faster runs. This repo answers *"is pi support a graft PR, or pi
extensions?"* with: **both, but each side is small** — and ships the pi side
with the **same integration depth Claude Code gets**.

## TL;DR

| Layer | Claude Code | pi (this package) |
|---|---|---|
| Instructions | `AGENTS.md` section / skill file | same — pi auto-loads `AGENTS.md` (`graft init --agents agents`); skill bundled here + upstream `pi` host proposed |
| Per-prompt retrieval | UserPromptSubmit hook: gated `ask --json -n 3`, strength + novelty gates, scope hint | same, via `before_agent_start` → this turn's system prompt |
| Session orientation | SessionStart hook: directive + INDEX.md + stale banner | same, once per session, as a persistent message |
| Post-edit | dirty mark + stale count + blast radius inline | same, via `tool_result` on edit/write |
| Savings tally | graft-vs-source counts, `~N tok saved` accumulator, reply-tally check | same, in the shared session file |
| Background sync | Stop hook: detached structural rebuild | same, via `agent_settled` (plain `build` only — never `--deep`) |
| Statusline | nodes/edges, freshness, tok saved, last file | same, via `ctx.ui.setStatus` (+ `/graft-status`) |
| Tools | MCP server (6 tools) | same 6 names, CLI-backed (pi ships no MCP client) |

**Shared state, not a lookalike:** stats live in `graft/.cache/stats.json` and
per-session counters in `graft/.cache/session/<id>.json` using graft's own
schema, so `graft stats`, a Claude session, and a pi session in the same repo
read and update the same numbers. Every hook is fail-soft — a graft failure
never fails the turn.

## Prerequisites

```bash
npm install -g @nanonets/graft   # the graft CLI
graft build                      # build graft/ in your repo (deterministic, no key, $0)
# optional, for LLM concept nodes:
graft build --deep               # needs GRAFT_API_KEY (or --provider/--model/--api-key)
```

## Install this package

```bash
pi install npm:pi-graft
# or project-local (shared with the team via .pi/settings.json):
pi install -l npm:pi-graft
# or try without installing:
pi -e npm:pi-graft
```

Then wire the instruction layer in each repo you work in:

```bash
graft init --agents agents   # writes the AGENTS.md section pi already loads
graft build
```

Restart pi (or `/reload`). The footer shows `graft <ver>: …ready/synced/stale`,
new sessions get the orientation message, and every prompt is retrieval-gated
like Claude's.

## What you get

**Hooks (automatic — the Claude behaviors):**

- *Orientation.* First turn of each session injects the always-on directive +
  `graft/INDEX.md` slice + stale banner (when the graph drifted).
- *Per-prompt retrieval.* Every prompt ≥12 chars runs `graft ask --json -n 3`
  (6s budget, pointers-only — never `--source`, so per-prompt tokens stay tiny)
  through the strength gate (symbol-name or broad match required, else a capped
  weak-match nudge) and the novelty gate (already-injected pointers are never
  re-injected). Multi-scope repos narrow via the last-edited file's scope.
- *Post-edit.* Editing a file appends its blast radius (who depends on it, top
  8, read straight from the wiring graph — no subprocess) to the tool result,
  marks the graph dirty, and refreshes the stale count from `graft check`.
- *Savings tally.* Every tool call is classified (graft vs source reads;
  a `[graft] tokens saved ≈ N` footer promotes even a bare `bash graft …` to
  graft) and folded into the session counters; turn ends check whether the
  reply told the user what was saved (`graftTurns`/`reportedTurns`, same as
  `graft stats` consumes).
- *Background sync.* At settle, a dirty graph triggers a detached structural
  `graft build` (MONEY GUARD: never `--deep`), with completion recorded in the
  shared stats cache. Every query also refreshes structurally before answering,
  so answers are never stale regardless.

**Tools** (same six operations as graft's MCP server, CLI-backed):

| Tool | Does | CLI equivalent |
|---|---|---|
| `graft_find_code` | ranked concept search, source inlined | `graft ask --source` |
| `graft_find_all` | exhaustive pattern search, grouped by symbol | `graft grep` |
| `graft_trace_calls` | exact caller/callee edges + blast radius | `graft callers` |
| `graft_file_api` | signatures-only file view (~10x cheaper) | `graft skeleton` |
| `graft_repo_map` | cold-start orientation | `graft map` |
| `graft_check_freshness` | drift report | `graft check` |

**Skill** (`/skill:graft`): the full usage playbook — which tool per task shape,
one-call discipline, savings tally. Mirrors upstream's skill text with pi tool
names.

**Commands**: `/graft-build`, `/graft-check`, `/graft-map`, `/graft-status`
(graph stats + this session's graft/source reads + tally ratio).

**Status**: footer shows `◤ graft · N nodes / M edges · ✓ synced / ⚠ N stale /
syncing… · ~N tok saved · last: file`. (pi's own footer already shows context
usage, and per-turn billing isn't exposed to pi extensions, so no ctx% or
dollar figure — tokens alone, never priced by hand.)

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `GRAFT_BIN` | `graft` | graft binary (absolute path if not on PATH) |
| `GRAFT_TIMEOUT_MS` | `30000` | per-command timeout for tools/commands |
| `GRAFT_DIR` | — | custom graph dir (same override the CLI honors) |

## Upstream PR

Graft upstream tracks the `pi` host in [trailhq/Graft#341](https://github.com/trailhq/Graft/pull/341)
(`graft init --agents pi` → `.pi/skills/graft/SKILL.md`). Until it merges, this
package's bundled skill covers the same ground. No upstream change is needed
for the hooks — those live entirely in this extension.

## Repo layout

```
package.json            pi package manifest (extensions + skills)
extensions/graft.ts     the extension — hooks, tools, status, commands
skills/graft/SKILL.md   the skill — usage playbook for the model
```

## License

MIT.
