---
name: graft
description: This repo is indexed by graft/. For ANY task here — understanding how something works, finding where code lives, tracing what calls a symbol or what a change breaks, or scoping an edit — get context from graft before grepping or reading source files.
---

# graft

`graft/` holds a graph of this repo: small markdown nodes that each explain one
part in prose and name the exact `file:line` spans they cover, plus a wiring
graph of who-calls-what. Querying a node costs a few hundred tokens; rebuilding
that understanding by reading source costs thousands, and misses the edges.

Every command below is `$0`, needs no API key, and returns in under a second.
There are six of them. **Pick the one that fits the task, run it, act on the
answer; don't chain tools hoping for more. Most tasks need one call.**

In pi you have **two surfaces** with identical guidance — prefer the native
tools when available, fall back to the CLI otherwise:

| Native pi tool | CLI equivalent |
|---|---|
| `graft_find_code` | `graft ask "<q>" --source` |
| `graft_find_all` | `graft grep "<pattern>"` |
| `graft_trace_calls` | `graft callers <symbol>` |
| `graft_file_api` | `graft skeleton <file>` |
| `graft_repo_map` | `graft map` |
| `graft_check_freshness` | `graft check` |

## The tools

### 1 · Find code: locate + understand (the default)

- Tool: `graft_find_code` with `{ query, limit?, full?, in? }`
- CLI: `graft ask "<question>" --source` (add `--full` only when the crux is
  too small, `--in <path>` to narrow, `-n N` to cap results, default 8)

Ranked retrieval over the graph, returning the top hits with exact `file:line`
plus the ≤8-line **crux** of each definition inlined — the result IS the code
you need, no follow-up file read.

- **Use it when** the question is conceptual or locational: "how does auth
  work", "where is rate-limiting handled", "what assembles the request pipeline".
- One ask usually answers. A genuinely multi-part question needs one ask per
  distinct sub-aspect, never the same question reworded. Few or weak hits mean
  switch tool (find-all / file-api / trace-calls), don't re-ask.

### 2 · Find all: exhaustive find

- Tool: `graft_find_all` with `{ pattern, in?, ignore_case?, fixed? }`
- CLI: `graft grep "<pattern>"` (add `--fixed` for a literal, `-i` for
  case-insensitive, `--in <path>` to scope)

Regex over every indexed file, hits **grouped by enclosing symbol** and ranked
by coupling.

- **Use it when** you need every occurrence: all call sites, all uses of a
  constant, all providers. Ranked find-code is top-N and *will* miss instances;
  find-all won't. One find-all replaces a spray of find-code calls.
- Search a **short symbol name or literal**, not a full guessed signature: an
  over-specific regex returns nothing even when the code is indexed. If a search
  misses, **loosen it** (drop the receiver and signature, keep the bare name)
  and retry — do NOT switch to raw `grep -rn`, which is slower and unranked.
- Raw `grep -rn` is only for files graft genuinely doesn't index (docs, configs,
  brand-new files).

### 3 · File API: a file's API at a glance

- Tool: `graft_file_api` with `{ file }`
- CLI: `graft skeleton <file>`

Signatures-only view of one file (every function / method / type with its span)
in ~200 tokens, ~10x cheaper than reading the file.

- **Use it when** you need "what's in this file / what can I call here" before
  editing or wiring into it. One skeleton is the whole answer for a file; don't
  re-skeleton the same file, and don't skeleton every file `map` already named.

### 4 · Trace calls: the exact edges

- Tool: `graft_trace_calls` with `{ symbol, direction?, depth?, in? }`
- CLI: `graft callers <symbol>` (`--direction in|out`, `--depth N|all`)

Precomputed call/reference edges, not a text search. Symbol can be bare
(`Foo`), qualified (`Class.method`), or package-qualified (`pkg.Fn`).

- `direction: in` (default): **who calls/references** this; run before you
  rename, delete, or change its signature.
- `direction: out`: **what this symbol itself calls/depends on**.
- `depth: 2`: the usual "what breaks if I touch this".
- `depth: "all"`: the **entire connected closure** — reach for this before a
  **refactor, rename, or any multi-file change**: it surfaces the sibling and
  downstream files that a single-file edit would miss.

### 5 · Repo map: orientation for an unfamiliar repo or area

- Tool: `graft_repo_map` with `{ max_dirs? }`
- CLI: `graft map` (`--max-dirs N` widens it)

A token-budgeted tour: directory clusters, per-directory hubs, and global
hotspots, straight from the wiring graph.

- **Use it when** you land in a repo cold or are asked for "the architecture".
  `map` alone is the answer: read the hub cards it names; do NOT then skeleton
  or ask your way through every subsystem it lists.

### 6 · Lifecycle: build / check

- CLI: `graft build` / `graft check` (also `/graft-build`, `/graft-check` in pi)
- Tool: `graft_check_freshness` (drift report only — it never rebuilds)

Every tool above refreshes the graph itself before answering, so results always
describe the code as it is right now — including edits you just made and have
not committed. You do **not** need to run `build` after editing.

`build` is for the LLM layer (`--deep` adds a concept map; skip unless asked);
`check` fails when `graft/` is stale, for CI.

## Scenarios: the shortest path through a coding task

| When you're… | Reach for | Calls |
|---|---|---|
| Onboarding / "explain this codebase" | repo-map, then read the named hub cards | 1 |
| Understanding a flow ("how does X work") | find-code | 1 |
| Finding where a change belongs | find-code ("where is <behavior>") | 1 |
| Editing a symbol you can already name | find-all (`<symbol>`), edit at the `file:line` (skip find-code — you know where it is) | 1 |
| Renaming / deleting / changing a signature | trace-calls depth 2 first | 1 |
| Refactor / multi-file change (before editing) | trace-calls depth all — map every connected file | 1 |
| "What does this depend on?" | trace-calls direction out | 1 |
| Finding every occurrence of a pattern | find-all (`<literal>`) | 1 |
| "What's the API of this file?" | file-api | 1 |
| Debugging a failure in area X | find-code (`<symptom>`), then trace-calls on the suspect | 1–2 |
| Judging a diff's risk before merge | trace-calls depth 2 per changed symbol | 1 / symbol |
| Working inside one repo of a monorepo | add `in: <scope>/` to find-code / find-all / trace-calls | n/a |

## Spend the fewest calls

- A node's `covers:` list already gives exact `file:line` for every symbol, so
  cite straight from it. The spans are generated from source and authoritative;
  don't re-open or re-grep files to "double-check".
- When the task already names the file or symbol to change, go straight there:
  find-all for the exact `file:line`, then edit. Reserve find-code for when you
  don't yet know where the code lives.
- Trust the answer and act. Reach for a second tool only when the first genuinely
  fell short: weak hits, a truncated span, or a need to be exhaustive.
- If graft names a path that isn't on disk, its index is ahead of your checkout
  (a branch switch or unpulled move). Don't read the missing file — find-all the
  symbol to find where it lives now, or run `graft build` to refresh.

## Report what graft saved, every turn

Each retrieval tool **opens** its output with a `[graft] tokens saved ≈ N` line:
the estimated tokens that call saved versus reading the files it covers whole.
Whenever you used any graft tool in a turn, close your reply with a one-line
tally summing those numbers across every graft call you made, e.g.
`🌱 graft saved ~12,400 tokens this turn (3 calls)`. A call with no such line
(tiny files, where the pointers cost as much as the source) saved nothing, so
skip it.

**Never pipe a graft command through `head`, `tail`, or `sed -n`.** Every tool
is already capped and states what it dropped; clipping it costs you hits you
asked for, and it silently drops the savings line.

## When graft isn't enough

- Span truncated ("+N more lines"): open the file at that exact range.
- A node lacks a detail: ask a more specific question; only then read source at
  the exact `file:line`, never a whole file to rebuild understanding graft gives.
- You may also grep / ls / cat inside `graft/` directly (plain markdown;
  `graft/INDEX.md` indexes the nodes), but the tools above are faster and
  exhaustive where it matters, so reach for them first.
