#!/usr/bin/env bash
set -e

# Route GitHub HTTPS auth to the right token per repo org (see
# scripts/git-credential-org-router.sh). Global config so it applies in every
# repo in the container; ~/.gitconfig isn't a persisted volume, so re-applying
# here on each create is what makes it survive rebuilds. The org→token map (if
# any) is read from the host mount at push time — not configured here.

echo "🔑 Configuring GitHub credential routing (org → token)..."

helper="/workspace/.devcontainer/scripts/git-credential-org-router.sh"
chmod +x "$helper" 2>/dev/null || true

# Pass the repo path (hence org) to the helper, and replace any prior helper for
# this host context with ours.
git config --global credential.https://github.com.useHttpPath true
git config --global --unset-all credential.https://github.com.helper 2>/dev/null || true
git config --global credential.https://github.com.helper "!$helper"

echo "✅ GitHub pushes route by org (map → convention → GITHUB_TOKEN fallback)"
