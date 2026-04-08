# OpenQwenCode agent and contributor guide

This is the central handoff file for future AI agents and human contributors.

Use this file as the project memory for working rules, release behavior, current status, and the remaining backlog.

## Non-negotiable rules

- Everything in this project must be written in English.
- The plugin intentionally exposes only `openqwencode/coder-model`.
- Do not reintroduce legacy `qwen`, `qwen-code`, `qwen3-coder-plus`, `qwen3-vl-plus`, or `vision-model` IDs.
- Keep the package root export compatible with OpenCode: the root package entrypoint must resolve to the plugin function.
- Keep helper/event exports on subpaths instead of adding extra root exports that could break OpenCode plugin loading.

## Current project status

Current release: `0.1.5`

The plugin currently includes:

- Qwen OAuth device flow with PKCE
- persistent credential storage in `~/.qwen/oauth_creds.json`
- atomic writes plus a lockfile
- in-memory credential cache with periodic disk sync
- proactive token refresh
- single-flight refresh deduplication for concurrent refresh attempts
- retry and backoff handling
- auth cancellation hooks
- legacy provider disabling
- request metadata injection for upstream compatibility
- request normalization for OpenCode chat payload compatibility
- smoke tests for provider registration, refresh-on-401 behavior, concurrent refresh deduplication, readable refresh failures, request normalization, and package export shape

## Repository map

- `README.md`: user-facing install and usage documentation
- `plugin.js`: main plugin implementation
- `index.js`: root package entrypoint, exports the plugin default for OpenCode compatibility
- `events.js`: subpath exports for `qwenAuthEvents` and `cancelActiveQwenAuth`
- `smoke-test.mjs`: smoke test coverage
- `.github/workflows/npm-publish.yml`: CI validation and npm publish workflow
- `AGENTS.md`: contributor/agent memory and backlog

## OpenCode compatibility notes

- OpenCode failed to load the package when the root module exposed multiple top-level exports.
- Keep the root package entrypoint minimal and plugin-first.
- If extra internals need to stay public, export them through subpaths such as `./events` instead of the root package export.

## Release and publishing workflow

Publishing is automated through GitHub Actions in `.github/workflows/npm-publish.yml`.

### Validation behavior

The workflow runs automatically on:

- pushes to `main`
- pull requests
- manual `workflow_dispatch`
- GitHub Releases with event type `published`

The build job does the following:

1. installs dependencies with `npm ci`
2. runs `npm test`
3. runs `npm pack --dry-run --json`
4. fails if the npm package contents differ from the expected file list
5. runs `npm publish --dry-run`

Expected npm package contents:

- `README.md`
- `events.js`
- `index.js`
- `package.json`
- `plugin.js`

### Actual npm publishing behavior

- The `publish-npm` job runs only for `release` and `workflow_dispatch` events.
- A GitHub Release publish is intended to automatically publish the same version to npm.
- The workflow checks that the GitHub release tag matches `package.json` version after stripping a leading `v`.
- npm publishing uses `npm publish --provenance`.
- The repository must have `NPM_TOKEN` configured in GitHub Actions secrets.

### Safe release checklist

Before creating a GitHub Release:

1. update `package.json` version
2. make sure tests pass locally with `npm test`
3. make sure `npm publish --dry-run` still passes locally
4. push to GitHub
5. create the GitHub Release with tag `v<package-version>`

## Local validation commands

```bash
npm test
npm pack --dry-run --json
npm publish --dry-run
```

Optional workflow syntax check:

```bash
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/npm-publish.yml'); puts 'YAML OK'"
```

## External references already reviewed

These were reviewed and should not need to be rediscovered from scratch:

- `QwenLM/qwen-code`: best upstream reference for auth direction and refresh behavior
- `foxswat/opencode-qwen-auth`: best reference for advanced resilience features and OpenCode integration ideas
- `RunMintOn/OpenCode-Qwen-Proxy`: useful reference for throttling and burst handling
- `1579364808/opencode-qwen-auth`: useful as an older baseline
- `gustavodiasdev/opencode-qwencode-auth`: older OpenCode-oriented implementation, less compelling than newer forks

## Current backlog

### High priority

#### 1. Request throttling with jitter

Why it matters:

Right now the plugin reacts to `429` responses after they happen. Adding light throttling before sending requests can reduce burst traffic and avoid rate limits more often.

Reference:

- `RunMintOn/OpenCode-Qwen-Proxy`

What to add:

- a tiny request queue or minimum spacing between upstream requests
- random jitter so concurrent clients do not retry in lockstep

Suggested behavior:

- minimum spacing between requests
- small randomized delay window
- keep existing retry logic as secondary protection

Relevant code areas:

- `buildFetchWithAuth()`
- `getBackoffMs()`

Priority: must-have

---

#### 2. Rate-limit-reason-aware backoff

Why it matters:

Not every `429` means the same thing. Temporary burst limits and quota exhaustion should not use the same retry timing.

Reference:

- `foxswat/opencode-qwen-auth`

What to add:

- inspect headers such as `x-error-code`
- distinguish between temporary rate limit, quota exhaustion, and server-side retry cases
- choose different wait windows per category

Relevant code areas:

- `buildFetchWithAuth()`
- backoff helpers near `getBackoffMs()`

Priority: must-have

### Good follow-up improvements

#### 3. Add a device-flow smoke test

Why it matters:

The current smoke tests cover config registration and refresh behavior well, but the actual device authorization polling path is still not tested.

What to test:

- `authorization_pending`
- `slow_down`
- successful token issuance
- credential persistence after auth success

Relevant files:

- `smoke-test.mjs`

Priority: nice-to-have

---

#### 4. Config file and environment variable overrides

Why it matters:

The plugin currently uses hardcoded constants. Small config overrides would make tuning easier without editing source code.

Possible options:

- refresh buffer
- throttle interval
- retry/backoff limits
- optional quiet/debug mode

Reference:

- `foxswat/opencode-qwen-auth`

Priority: nice-to-have

---

#### 5. Minor cleanup items

- add jitter to the current generic backoff function
- make the user-agent version come from package metadata
- optionally add a logout or credential wipe helper
- add a short code comment explaining the system-message injection fallback behavior

Priority: nice-to-have

## Recently completed work

- single-flight refresh deduplication was added to avoid concurrent refresh races
- package export shape was fixed so OpenCode now loads the plugin correctly
- request metadata, request normalization, and user-agent handling were tightened for upstream compatibility
- npm publish hygiene checks were added to CI and release automation
- release `0.1.4` was published with successful GitHub Actions validation and release workflow execution

## Probably not worth the complexity right now

### Multi-account rotation

This exists in more advanced community plugins, but it would significantly increase scope and maintenance burden. Only add it if multi-account usage becomes an explicit goal.

### Responses API to Chat Completions translation

Only worth adding if OpenCode starts sending incompatible request or stream formats for this plugin path.

### Reintroducing legacy Qwen model IDs

Do not add this back. The plugin intentionally exposes only `openqwencode/coder-model`.

## Suggested implementation order

1. Request throttling with jitter
2. Rate-limit-reason-aware backoff
3. Device-flow smoke test
4. Config or environment overrides
