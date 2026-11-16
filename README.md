# forge — a GitHub-compatible git forge for github-core-clone-01

A single-process forge in Node TypeScript, standard library only: no npm
packages, no git binary, no network beyond the trial env's lifecycle calls.
It implements the contest surface end to end over one shared in-memory
store, so an object created on any surface is the same object on all of
them.

## Run it

```sh
node main.ts
```

The program reads `MAKEFUN_ENV_URL`, `MAKEFUN_SHOP_TOKEN`,
`MAKEFUN_TRIAL_NOW` and `MAKEFUN_TRIAL_SEED` from its environment, binds an
ephemeral port, registers it with the env, serves until the env answers
`{"done": true}` on `/done`, then exits 0. With no `MAKEFUN_ENV_URL` it
serves standalone (handy for local checks).

## What's inside

- `main.ts` — the lifecycle: bind port 0 → register → poll /done → exit 0.
- `app.ts` — one HTTP server routing to every surface; bearer-token auth
  everywhere but `GET /healthz`; a request-id header on every reply; no
  handler exception can take the process down.
- `store.ts` — the shared state: repositories, refs, labels, issues, pull
  requests (one number counter per repo, as on GitHub), comments, and the
  operations all surfaces funnel through, including the squash merge.
- `gitobj.ts` — the git object model by hand: SHA-1 ids, zlib, tree/commit
  build and parse in git's sort order, packfile reading (ofs-delta and
  ref-delta) and writing, ancestry, fetch planning with shallow/deepen,
  three-way merges and line diffs.
- `rest.ts` — REST v3 under `/api/v3`: root + OAuth scopes, meta, user,
  repos with Link pagination, contents (PUT 201/200/409, DELETE), branches,
  refs, commits, labels, issues with comments, pulls with files and merge.
- `githttp.ts` — git smart HTTP at `/{owner}/{repo}.git`: protocol v2
  advertisement, ls-refs with prefix filtering, fetch (sections, shallow,
  deepen), the v0 fallback with side-band-64k, and receive-pack with
  fast-forward-only ref updates and per-ref report-status.
- `graphql.ts` — a hand-written GraphQL parser/executor for the documented
  surface: viewer, repository connections with cursor pagination and
  CREATED_AT ordering, node, `__type` introspection, batched operations,
  and the createIssue / closeIssue / createPullRequest / mergePullRequest /
  addComment mutations, all consistent with REST.
- `mcp.ts` — MCP at `/mcp` in both protocol eras (`server/discover` for
  2026-07-28, `initialize` for the handshake era), with create_repo,
  get_repo, create_issue, list_issues, create_pull_request and
  merge_pull_request over the shared store.
- `clock.ts` — deterministic time: every timestamp derives from
  `MAKEFUN_TRIAL_NOW` plus a per-object logical counter, so replayed trials
  produce byte-identical exports. No `Date.now()`, no `Math.random()` in
  stored state or compared output.

## Local verification

Against the kit's own runner and env, with the practice trial values, the
forge passes all 120 conformance checks (git 30, repos 15, issues 15,
pulls 20, graphql 20, mcp 15, protocol 5) and exits 0 on `done`, with the
exported `state.json` identical across repeated trials.
