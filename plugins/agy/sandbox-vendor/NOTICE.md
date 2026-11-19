# Vendored Seatbelt policies

`codex_seatbelt_base_policy.sbpl`, `codex_seatbelt_network_policy.sbpl` and
`codex_seatbelt_preferences_policy.sbpl` are copied verbatim from
[openai/codex](https://github.com/openai/codex) (`codex-rs/sandboxing/src/`,
commit `696b4502dfaacd91133c3691a23dc91ae3b14bc9`). They are licensed under the
Apache License 2.0; the full text is in [`LICENSE`](LICENSE) in this folder.
The rest of this project is MIT-licensed.

Upstream NOTICE:

> OpenAI Codex
> Copyright 2025 OpenAI

They provide the deny-by-default base (process, sysctl, IPC and platform-service
allowances) that `scripts/lib/sandbox.mjs` composes with this plugin's own
write, network and credential rules. Refresh or verify them with
`scripts/update-vendor-sbpl.sh` (`--check` verifies without changing anything).
