# OpenQwenCode improvement checklist

This file tracks the most relevant improvements still worth considering before the next upload/release.

The current plugin is already in good shape:

- OAuth device flow with PKCE
- persistent credential storage in `~/.qwen/oauth_creds.json`
- atomic writes + lockfile
- in-memory credential cache
- proactive refresh
- retry/backoff support
- auth cancellation hooks
- legacy provider disabling
- smoke tests for provider registration and refresh retry

## Highest-priority improvements

### 1. Single-flight refresh deduplication

Why it matters:

If multiple requests hit `401`/`403` at the same time, they can all try to refresh simultaneously. If Qwen rotates refresh tokens, one refresh can invalidate the token used by another request.

What to add:

- a module-level in-flight refresh promise
- make concurrent refresh callers await the same promise
- clear the promise after success or failure

Relevant code areas:

- `getValidCredentials()`
- `buildFetchWithAuth()`

**Priority**: must-have

---

### 2. Request throttling with jitter

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

**Priority**: must-have

---

### 3. Rate-limit-reason-aware backoff

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

**Priority**: must-have

## Good follow-up improvements

### 4. Add a device-flow smoke test

Why it matters:

The current smoke tests cover config registration and refresh-on-401 behavior well, but the actual device authorization polling path is still not tested.

What to test:

- `authorization_pending`
- `slow_down`
- successful token issuance
- credential persistence after auth success

Relevant files:

- `smoke-test.mjs`

**Priority**: nice-to-have

---

### 5. Config file and environment variable overrides

Why it matters:

The plugin currently uses hardcoded constants. Small config overrides would make tuning easier without editing source code.

Possible options:

- refresh buffer
- throttle interval
- retry/backoff limits
- optional quiet/debug mode

Reference:

- `foxswat/opencode-qwen-auth`

**Priority**: nice-to-have

---

### 6. Minor cleanup items

- add jitter to the current generic backoff function
- make the user-agent version come from package metadata
- optionally add a logout/credential wipe helper
- add a short code comment explaining the system-message injection fallback behavior

**Priority**: nice-to-have

## Probably not worth the complexity right now

### Multi-account rotation

This exists in more advanced community plugins, but it would significantly increase scope and maintenance burden. It is only worth adding if multi-account usage becomes an explicit goal.

### Responses API ↔ Chat Completions translation

Only worth adding if OpenCode actually starts sending incompatible request/stream formats for this plugin path.

### Reintroducing legacy Qwen model IDs

Do not add this back. The plugin intentionally exposes only `openqwencode/coder-model`.

## Notes on external references

- `QwenLM/qwen-code`: best upstream reference for auth direction and refresh behavior
- `foxswat/opencode-qwen-auth`: best reference for advanced resilience features
- `RunMintOn/OpenCode-Qwen-Proxy`: useful reference for throttling and burst handling
- `1579364808/opencode-qwen-auth`: useful as an older baseline, but not a source of major missing features
- `gustavodiasdev/opencode-qwencode-auth`: older and less compelling than newer forks

## Suggested implementation order

1. Single-flight refresh deduplication
2. Request throttling with jitter
3. Rate-limit-reason-aware backoff
4. Device-flow smoke test
5. Config/env overrides
