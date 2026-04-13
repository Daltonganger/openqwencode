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

Current release: `0.1.8`

Release `0.1.8` changes:

- `OPENQWENCODE_BASE_URL` now allows routing model requests through a custom OpenAI-compatible base URL
- optional telemetry can now post request metadata to a configured endpoint and attach a bearer token for linked devices
- a device-link flow now supports linking installs through `linkDevice()` and the new `link.js` CLI/subpath
- telemetry link credentials are now stored separately in `~/.qwen/telemetry_creds.json`
- smoke tests now cover base URL overrides, telemetry delivery, bearer-token telemetry auth, and device-link persistence

The plugin currently includes:

- Qwen OAuth device flow with PKCE
- persistent credential storage in `~/.qwen/oauth_creds.json`
- atomic writes plus a lockfile
- in-memory credential cache with periodic disk sync
- proactive token refresh
- single-flight refresh deduplication for concurrent refresh attempts
- light upstream request throttling with jitter
- retry and backoff handling
- OpenAI-compatible rate-limit error shaping for cleaner OpenCode notifications
- debug logging disabled by default unless explicitly enabled
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
- `link.js`: subpath export and CLI entry for telemetry device linking
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
- `link.js`
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

### Next priorities

#### 1. Config file and environment variable overrides

Why it matters:

The plugin currently uses hardcoded constants. Small config overrides would make tuning easier without editing source code.

Possible options:

- refresh buffer
- throttle interval
- retry/backoff limits
- optional quiet/debug mode

Reference:

- `foxswat/opencode-qwen-auth`

Status note:

- only `OPENQWENCODE_DEBUG` exists today

Priority: follow-up

---

#### 2. Remaining minor cleanup item

- optionally add a logout or credential wipe helper

Priority: nice-to-have

## Recently completed work

- rate-limit-reason-aware backoff classifies 429s by `x-error-code` into burst, quota, and transient categories with distinct retry windows
- quota-exhausted 429s now return `quota_exceeded` in OpenAI-compatible error JSON
- smoke tests now cover rate-limit reason classification for burst, quota, and transient cases
- a deterministic device-flow smoke test covers `authorization_pending`, `slow_down`, successful token issuance, and credential persistence
- single-flight refresh deduplication was added to avoid concurrent refresh races
- light request throttling with jitter was added before upstream calls
- rate-limited upstream failures are now reshaped into clean OpenAI-compatible JSON errors for OpenCode
- debug logging now stays quiet by default unless `OPENQWENCODE_DEBUG` is enabled
- package export shape was fixed so OpenCode now loads the plugin correctly
- request metadata, request normalization, and user-agent handling were tightened for upstream compatibility
- the user-agent version now comes from package metadata
- a short code comment now explains the system-message injection fallback behavior
- npm publish hygiene checks were added to CI and release automation
- release `0.1.5` was published with successful GitHub Actions validation and release workflow execution
- release `0.1.6` was published with improved upstream request compatibility
- release `0.1.7` was published with rate-limit-aware backoff and deterministic device-flow smoke coverage

## Probably not worth the complexity right now

### Multi-account rotation

This exists in more advanced community plugins, but it would significantly increase scope and maintenance burden. Only add it if multi-account usage becomes an explicit goal.

### Responses API to Chat Completions translation

Only worth adding if OpenCode starts sending incompatible request or stream formats for this plugin path.

### Reintroducing legacy Qwen model IDs

Do not add this back. The plugin intentionally exposes only `openqwencode/coder-model`.

## Suggested implementation order

1. Config or environment overrides
2. Optional credential wipe helper
