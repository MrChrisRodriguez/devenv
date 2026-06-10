#!/usr/bin/env bash
set -e

echo "📊 Setting up ccstatusline (Claude Code status line)..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun/jq (and put ~/.bun/bin on PATH)
setup_proto_env

# The `ccstatusline` binary installs to ~/.bun/bin, which is NOT volume-mounted,
# so it is wiped on every rebuild — re-install it here so the status line keeps
# working. bun is required for the install; jq (proto-managed) is used below to
# merge the statusLine block into ~/.claude/settings.json.
if ! command -v bun &> /dev/null; then
    echo "⚠️   bun not found on PATH (expected via Proto); skipping ccstatusline setup"
    return 0
fi

if command -v ccstatusline &> /dev/null; then
    echo "ℹ️  ccstatusline already installed at $(command -v ccstatusline), skipping install"
else
    echo "📦 Installing ccstatusline via bun..."
    bun add -g ccstatusline \
        || echo "⚠️   Could not install ccstatusline (run 'bun add -g ccstatusline' manually)"
fi

# Seed the ccstatusline layout on a fresh ~/.config volume from the committed
# config so the intended status line (model · context · git branch · git
# changes) shows up without manual reconfiguration. Never clobber an existing
# config. (~/.config IS volume-mounted, so this normally persists on its own.)
CCSTATUSLINE_CONFIG="$HOME/.config/ccstatusline/settings.json"
CCSTATUSLINE_SEED="/workspace/.devcontainer/ccstatusline-settings.json"
if [ ! -f "$CCSTATUSLINE_CONFIG" ] && [ -f "$CCSTATUSLINE_SEED" ]; then
    echo "🔧 Seeding ccstatusline layout from committed config..."
    mkdir -p "$(dirname "$CCSTATUSLINE_CONFIG")"
    cp "$CCSTATUSLINE_SEED" "$CCSTATUSLINE_CONFIG"
fi

# Point Claude Code at ccstatusline. On a new repo ~/.claude is a fresh
# per-project volume, so the statusLine block must be written here — nothing
# else seeds it. Merge it in WITHOUT clobbering existing settings or a
# statusLine the user already configured by hand.
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
if command -v jq &> /dev/null; then
    mkdir -p "$(dirname "$CLAUDE_SETTINGS")"
    [ -f "$CLAUDE_SETTINGS" ] || echo '{}' > "$CLAUDE_SETTINGS"
    if jq -e '.statusLine' "$CLAUDE_SETTINGS" > /dev/null 2>&1; then
        echo "ℹ️  statusLine already configured in $CLAUDE_SETTINGS, leaving as-is"
    else
        tmp="$(mktemp)"
        if jq '.statusLine = {"type":"command","command":"ccstatusline","padding":0,"refreshInterval":10}' \
            "$CLAUDE_SETTINGS" > "$tmp"; then
            mv "$tmp" "$CLAUDE_SETTINGS"
            echo "🔧 Wired statusLine to ccstatusline in $CLAUDE_SETTINGS"
        else
            rm -f "$tmp"
            echo "⚠️   Could not write statusLine to $CLAUDE_SETTINGS"
        fi
    fi
else
    echo "⚠️   jq not found; skipping statusLine wiring (add manually to ~/.claude/settings.json)"
fi

echo "✅ ccstatusline setup complete!"
