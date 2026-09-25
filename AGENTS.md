# pi-graft — agent instructions

Pi-side Graft support for the pi harness at Claude-Code parity. See README.md
for the full integration table (hooks, tools, shared state schema).

## Local entrypoints

- `extensions/graft.ts` — the pi extension (hooks + CLI-backed tools).
- `skills/` — bundled skill files. `scripts/publish.sh` — release helper.
- `graft/` — this checkout's own context graph (INDEX.md + extensions).
- Tests: `npm ci && npm test` (Node >= 22.6, `node:test`, no network). The
  suite loads the real `extensions/graft.ts` with a fake pi and a fake
  `graft` CLI (`test/fixtures/`); add a case there for every hook change.
  CI: none.

## Shared guidance and Context Fabric (prepare-only, L1 informative)

- Profile: script-library, level L1 informative. Graft: applicable — this
  checkout owns its `graft/` cache; each worker checkout owns its own cache,
  never a shared mutable index.
- Adopted shared-guidance pin (reviewed immutable revision; active sessions
  keep their previous valid pin):
  - sourceRepo: `KSonny4/engineering-guidance`
  - revision: `656d5569f261afb75f7c7685bea55e1e71518f9b`
  - paths: `AGENTS.md`, `standards/context.md`
  - sha256: `98c72a903daf02f52b080a5ba5acac2459b69913040c48bb61b471867123eb4c`,
    `e2c9a66a09472eb8a99c06387063b85254565fdb40903b3ea16ad0c4454b4f3a`
- Task-based loading: fetch the pinned files, verify bytes against the hashes
  above, and supply them to the receiving agent before dependent work. A URL,
  a successful fetch alone, or a caller-set loaded flag is not proof of
  loading. Missing or mismatched guidance blocks the dependent action.
- Context Fabric search (interface v0.1 PROPOSED, unshipped): pending
  activation. No client is wired in this change; no endpoint is configured.
  Optional retrieval outage never waives mandatory guidance. Do not treat a
  `graft` graph build as document-indexing proof.
- Public-repo boundary: this file carries integrity metadata (revision +
  hashes) only — no private guidance text, no source excerpts, no hostnames,
  no credentials. Owner-agent sessions resolve private evidence through
  private settings; public contributors use this file standalone.
- Status: prepared (reviewable candidate). Adopted/loaded/indexed/verified
  remain pending until the shared runtime is published and the adoption is
  completed and re-verified.
