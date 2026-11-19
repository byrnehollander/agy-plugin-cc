# Contributing

## Development copy

```bash
git clone https://github.com/byrnehollander/agy-plugin-cc.git
claude plugin marketplace add ./agy-plugin-cc
claude plugin install agy@agy-plugin-cc
```

A local-path marketplace loads straight from your clone; run `/reload-plugins` in Claude Code after each change.

The code is plain Node.js ESM with no dependencies, in `plugins/agy/`. Slash commands are in `commands/`, the subagent in `agents/`, the instructions Claude follows in `skills/`, the preambles sent to Neon in `prompts/`, and the runtime in `scripts/`. In `scripts/lib/`, `sandbox.mjs` builds the Seatbelt profile, `egress.mjs` is the proxy, `policy.mjs` holds `agy`'s per-run rules and `classify.mjs` maps outcomes to exit codes.

## Tests

```bash
cd plugins/agy
npm run check      # syntax
npm test           # offline: unit, integration (fake agy) and model-free sandbox probes, ~30s
npm run test:live  # needs a signed-in agy; ~3 minutes and a little quota (gemini-4-neon-low)
```

Both suites touch your real machine. The sandbox probes try, and should fail, to write in your home folder, read secrets from a fake home, and start processes through `launchctl`, `open` and `osascript`. The live suite creates a temporary folder under your home folder and removes it afterwards.

Any change to `sandbox.mjs`, `egress.mjs`, `policy.mjs` or how `agy` is started should come with an offline test. A model-free probe in `test/sandbox-escape.test.mjs` is best, because it shows the kernel refusing a real attempt. Also run `npm run test:live` before merging. Live tests should check the end state (what exists afterwards), not whether the model chose to try something.

## Vendored Seatbelt policies

`plugins/agy/sandbox-vendor/` holds three policy files from [openai/codex](https://github.com/openai/codex) (Apache-2.0), all pinned to the commit in `SOURCE_COMMIT`.

```bash
scripts/update-vendor-sbpl.sh --check   # verify the files match the pinned commit (CI runs this)
scripts/update-vendor-sbpl.sh           # update everything to openai/codex main
```

## Releasing

1. Bump `version` in `plugins/agy/.claude-plugin/plugin.json` (users get updates only when it changes) and in `plugins/agy/package.json`.
2. Run `npm test` and `npm run test:live`, and update "Verified versions" in the README if the `agy` version changed. If a newer `agy` passed, also update `LAST_VERIFIED_VERSION` in `scripts/lib/agy.mjs`.
3. Add a CHANGELOG entry, then tag the release (`v0.2.0`).

By contributing you agree that your contributions are licensed under the MIT licence.
