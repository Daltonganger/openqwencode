# openqwencode

Local OpenCode plugin for qwen.ai OAuth, with the same persistent credential cache style as `qwen-code` and `opencode-qwen-auth`, but without the legacy built-in Qwen providers/models.

This plugin builds on the newer Qwen Code direction and refresh work, adapted for OpenCode as a dedicated plugin-based integration.

It was also created because older OpenCode Qwen auth plugins like [`1579364808/opencode-qwen-auth`](https://github.com/1579364808/opencode-qwen-auth) and [`gustavodiasdev/opencode-qwencode-auth`](https://github.com/gustavodiasdev/opencode-qwencode-auth) no longer work.

## Reviewed external references

This plugin was built after reviewing the main public Qwen/OpenCode auth implementations and forks, not just a single upstream:

- [`QwenLM/qwen-code`](https://github.com/QwenLM/qwen-code): primary upstream reference for OAuth flow, credential persistence, and refresh behavior
- [`foxswat/opencode-qwen-auth`](https://github.com/foxswat/opencode-qwen-auth): strongest reference for resilience improvements and OpenCode integration ideas
- [`RunMintOn/OpenCode-Qwen-Proxy`](https://github.com/RunMintOn/OpenCode-Qwen-Proxy): useful reference for throttling and burst-handling behavior
- [`1579364808/opencode-qwen-auth`](https://github.com/1579364808/opencode-qwen-auth): reviewed as an older baseline
- [`gustavodiasdev/opencode-qwencode-auth`](https://github.com/gustavodiasdev/opencode-qwencode-auth): reviewed as another older OpenCode-oriented implementation

The current design intentionally follows the strongest parts of those implementations while keeping the plugin small, current, and focused on the official free Qwen OAuth path.

## Language rule

- Everything in this project must be written in English.

## What this plugin does

- login provider: `openqwencode`
- model path: `openqwencode/coder-model`
- only the official free OAuth model: `coder-model`
- image input through the same `coder-model`
- tokens stored in qwen-code-compatible format in `~/.qwen/oauth_creds.json`
- automatic refresh so you do not have to log in again every day
- atomic writes + lockfile so multiple processes do not corrupt credentials
- in-memory cache with periodic disk sync
- backoff for `429` and temporary server errors
- cancellable auth polling, including process-signal cancellation
- removes/overrides legacy `qwen` and `qwen-code` providers

## OpenCode config

```json
{
  "$schema": "https://opencode.ai/config.json",
  "disabled_providers": ["qwen", "qwen-code"],
  "plugin": ["file:///ABSOLUTE/PATH/TO/openqwencode"]
}
```

Login:

```bash
opencode auth login -p openqwencode
```

Then use:

```bash
opencode --model openqwencode/coder-model
```

## Install and use in OpenCode

Install the package:

```bash
npm install openqwencode
```

Add it to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "disabled_providers": ["qwen", "qwen-code"],
  "plugin": ["openqwencode"]
}
```

Authenticate:

```bash
opencode auth login -p openqwencode
```

Run OpenCode with the plugin model:

```bash
opencode --model openqwencode/coder-model
```

## Notes

- upstream `QwenLM/qwen-code` only uses `coder-model` for the free OAuth flow
- `qwen3-coder-plus`, `qwen3-vl-plus`, and `vision-model` are intentionally no longer exposed
- the plugin injects the Qwen OAuth headers and a minimal Qwen Code system message
- the local credential file is the primary source of truth; OpenCode auth state is only used as a bootstrap/migration path
