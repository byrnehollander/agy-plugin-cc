# Changelog

## 0.2.0 — 2026-11-19

First public release.

- `/agy:rescue`, `/agy:review`, `/agy:adversarial-review`, `/agy:status`, `/agy:result`, `/agy:cancel` and `/agy:setup`, plus an `agy-rescue` subagent Claude can delegate to.
- Three modes: read-only (default), `--write` and `--shell`. Network access in `--shell` is opt-in per host with `--allow-host`, or for any host with `--web`. Web search works in every mode.
- Every run on macOS is confined by a Seatbelt kernel sandbox and an egress proxy. Credential-looking environment variables are removed, and a post-run report lists changed files.
- Verified against `agy` 1.5.12 on macOS arm64.
