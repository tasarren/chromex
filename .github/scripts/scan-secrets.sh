#!/bin/sh
# Scans full Git history and the current tracked/unignored tree with pinned Gitleaks and .gitleaks.toml.
# Prints redacted findings only (rule, file, line, commit). Needs network to download Gitleaks
# unless GITLEAKS_TARBALL names a local copy; either way the tarball must match the pinned digest.
# Usage: sh .github/scripts/scan-secrets.sh
set -eu
cd "$(dirname "$0")/../.."
version=8.30.1
digest=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
asset="gitleaks_${version}_linux_x64.tar.gz"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ -n "${GITLEAKS_TARBALL:-}" ]; then
  cp "$GITLEAKS_TARBALL" "$work/$asset"
else
  curl -fsSL --retry 3 -o "$work/$asset" \
    "https://github.com/gitleaks/gitleaks/releases/download/v$version/$asset"
fi
(cd "$work" && printf '%s  %s\n' "$digest" "$asset" | sha256sum -c --quiet)
tar -xzf "$work/$asset" -C "$work" gitleaks

# Tracked files deleted from the worktree are skipped; any other unreadable file stops the scan.
# Local negative: `chmod 000` a tracked file, then this script exits nonzero ("Permission denied").
mkdir "$work/tree"
# grep -f reads newline-separated patterns even with -z.
git ls-files -z --deleted | tr '\0' '\n' >"$work/gone"
git ls-files -z --cached --others --exclude-standard >"$work/all"
grep -zvxFf "$work/gone" "$work/all" >"$work/list" || [ $? -eq 1 ]
tar --null -cf "$work/tree.tar" -T "$work/list"
tar -xf "$work/tree.tar" -C "$work/tree"

# Gitleaks renders the report itself: rule, file, line and commit only, never the match.
printf '{{range .}}  {{.RuleID}} {{.File}}:{{.StartLine}} {{.Commit}}\n{{end}}' >"$work/report.tmpl"

status=0
scan() {
  label=$1
  shift
  if "$work/gitleaks" "$@" --no-banner --redact --exit-code 1 -c .gitleaks.toml \
    --report-format template --report-template "$work/report.tmpl" \
    --report-path "$work/$label.txt" >/dev/null 2>"$work/$label.err"; then
    printf '%s: no findings\n' "$label"
  else
    status=1
    printf '%s: findings or error\n' "$label" >&2
    if [ -s "$work/$label.txt" ]; then cat "$work/$label.txt" >&2; else tail -5 "$work/$label.err" >&2; fi
  fi
}
scan history git --log-opts=--all .
scan tree dir "$work/tree"
exit "$status"
