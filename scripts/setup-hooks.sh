#!/usr/bin/env bash
# setup-hooks.sh — Install cortextOS git hooks into the local repo
#
# Run once after cloning:
#   bash scripts/setup-hooks.sh
#
# Installs a pre-push hook that runs npm run build && npm test before
# any push. If either fails, the push is aborted and you fix it locally
# rather than failing on CI.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: must be run from inside a git repository." >&2
  exit 1
}

# Resolve the directory git actually executes hooks from. This honours
# core.hooksPath (e.g. husky's .husky/_) AND works inside a git worktree,
# where .git is a FILE and the old hardcoded "$REPO_ROOT/.git/hooks" errors
# with "not a directory". --git-path reflects core.hooksPath when set.
HOOKS_DIR="$(cd "$REPO_ROOT" && git rev-parse --path-format=absolute --git-path hooks 2>/dev/null)"
if [[ -z "$HOOKS_DIR" ]]; then
  # Fallback for git < 2.31 (no --path-format): anchor a relative path at REPO_ROOT.
  HOOKS_DIR="$(cd "$REPO_ROOT" && git rev-parse --git-path hooks)"
  case "$HOOKS_DIR" in /*) : ;; *) HOOKS_DIR="$REPO_ROOT/$HOOKS_DIR" ;; esac
fi
mkdir -p "$HOOKS_DIR"

install_hook() {
  local name="$1"
  local src="$REPO_ROOT/scripts/hooks/$name"
  local dest="$HOOKS_DIR/$name"

  if [[ ! -f "$src" ]]; then
    echo "Warning: hook source not found: $src (skipping)" >&2
    return
  fi

  # Non-clobbering: never overwrite an existing hook the user/operator installed
  # (e.g. a local leak-guard pre-push). Only install when there is no hook, or
  # when the existing hook is byte-identical to ours (already installed). The
  # -L catches a broken symlink too, which -e alone would miss (and then clobber).
  if [[ -e "$dest" || -L "$dest" ]]; then
    if cmp -s "$src" "$dest"; then
      echo "  Already installed: .git/hooks/$name"
    else
      echo "  Skipped: .git/hooks/$name already exists (leaving your hook in place)"
    fi
    return
  fi

  cp "$src" "$dest"
  chmod +x "$dest"
  echo "  Installed: .git/hooks/$name"
}

echo "Installing cortextOS git hooks..."
install_hook pre-push
install_hook post-merge
echo "Done. Hooks active for this repo clone."
