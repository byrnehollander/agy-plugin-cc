#!/usr/bin/env bash
# Vendored Codex Seatbelt policies (Apache-2.0, openai/codex).
#
#   scripts/update-vendor-sbpl.sh            update all files to openai/codex main
#   scripts/update-vendor-sbpl.sh <sha>      update all files to a specific commit
#   scripts/update-vendor-sbpl.sh --check    verify the vendored files match SOURCE_COMMIT
#
# All files are always taken from ONE commit, recorded in SOURCE_COMMIT and NOTICE.md.
set -euo pipefail
cd "$(dirname "$0")/../sandbox-vendor"

REPO="openai/codex"
FILES=(seatbelt_base_policy seatbelt_network_policy seatbelt_preferences_policy)
raw() { curl -fsSL --proto '=https' --retry 3 --max-time 60 "https://raw.githubusercontent.com/$REPO/$1/$2"; }

if [[ "${1:-}" == "--check" ]]; then
  sha="$(tr -d '[:space:]' < SOURCE_COMMIT)"
  status=0
  for f in "${FILES[@]}"; do
    if ! diff -q <(raw "$sha" "codex-rs/sandboxing/src/$f.sbpl") "codex_$f.sbpl" > /dev/null; then
      echo "codex_$f.sbpl differs from $REPO@$sha" >&2
      status=1
    fi
  done
  if ! diff -q <(raw "$sha" LICENSE) LICENSE > /dev/null; then
    echo "LICENSE differs from $REPO@$sha" >&2
    status=1
  fi
  [[ $status -eq 0 ]] && echo "Vendored files match $REPO@$sha."
  exit $status
fi

sha="${1:-}"
if [[ -z "$sha" ]]; then
  sha="$(curl -fsSL --proto '=https' --max-time 60 "https://api.github.com/repos/$REPO/commits/main" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).sha||""))')"
fi
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Could not resolve a commit sha (got '$sha')" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for f in "${FILES[@]}"; do raw "$sha" "codex-rs/sandboxing/src/$f.sbpl" > "$tmp/codex_$f.sbpl"; done
raw "$sha" LICENSE > "$tmp/LICENSE"
for f in "${FILES[@]}"; do mv "$tmp/codex_$f.sbpl" "codex_$f.sbpl"; done
mv "$tmp/LICENSE" LICENSE
echo "$sha" > SOURCE_COMMIT
sed -i.bak -E "s/commit \`[0-9a-f]{40}\`/commit \`$sha\`/" NOTICE.md && rm -f NOTICE.md.bak
echo "Updated to $REPO@$sha. Now run: npm test && npm run test:live"
