#!/usr/bin/env bash
set -e

echo "📊 Setting up ccstatusline (Claude Code status line)..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun (and put ~/.bun/bin on PATH)
setup_proto_env

# ~/.claude/settings.json points statusLine.command at the bare `ccstatusline`
# binary. That binary installs to ~/.bun/bin, which is NOT volume-mounted, so it
# is wiped on every rebuild — re-install it here so the status line keeps working.
# (~/.config IS volume-mounted, so the config below normally persists on its own.)
if ! command -v bun &> /dev/null; then
    echo "⚠️   bun not found on PATH (expected via Proto); skipping ccstatusline install"
    return 0
fi

if command -v ccstatusline &> /dev/null; then
    echo "ℹ️  ccstatusline already installed at $(command -v ccstatusline), skipping"
else
    echo "📦 Installing ccstatusline via bun..."
    bun add -g ccstatusline \
        || echo "⚠️   Could not install ccstatusline (run 'bun add -g ccstatusline' manually)"
fi

# Seed the config on a fresh ~/.config volume from the committed backup so the
# intended status line (model · context · git branch · git changes) shows up
# without manual reconfiguration. Never clobber an existing config.
CCSTATUSLINE_CONFIG="$HOME/.config/ccstatusline/settings.json"
CCSTATUSLINE_BACKUP="/workspace/.ccstatusline-settings.bak"
if [ ! -f "$CCSTATUSLINE_CONFIG" ] && [ -f "$CCSTATUSLINE_BACKUP" ]; then
    echo "🔧 Seeding ccstatusline config from committed backup..."
    mkdir -p "$(dirname "$CCSTATUSLINE_CONFIG")"
    cp "$CCSTATUSLINE_BACKUP" "$CCSTATUSLINE_CONFIG"
fi

echo "✅ ccstatusline setup complete!"
