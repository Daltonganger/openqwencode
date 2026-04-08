# openqwencode

Local OpenCode plugin for qwen.ai OAuth, with the same persistent credential cache style as `qwen-code` and `opencode-qwen-auth`, but without the legacy built-in Qwen providers/models.

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

## Notes

- upstream `QwenLM/qwen-code` only uses `coder-model` for the free OAuth flow
- `qwen3-coder-plus`, `qwen3-vl-plus`, and `vision-model` are intentionally no longer exposed
- the plugin injects the Qwen OAuth headers and a minimal Qwen Code system message
- the local credential file is the primary source of truth; OpenCode auth state is only used as a bootstrap/migration path
