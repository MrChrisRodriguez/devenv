#!/usr/bin/env bash
set -e

echo "🔌 Installing VS Code extensions..."

# Extract extensions from devcontainer.json (single source of truth)
DEVCONTAINER_JSON="/workspace/.devcontainer/devcontainer.json"

if [ ! -f "$DEVCONTAINER_JSON" ]; then
	echo "⚠️  devcontainer.json not found at $DEVCONTAINER_JSON"
	exit 1
fi

# Try to extract extensions using jq if available, otherwise use grep/sed
if command -v jq &> /dev/null; then
	# Use jq to extract extensions array
	EXTENSIONS=$(jq -r '.customizations.vscode.extensions[]?' "$DEVCONTAINER_JSON" 2>/dev/null)
elif command -v node &> /dev/null; then
	# Fallback to node if jq is not available
	EXTENSIONS=$(node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('$DEVCONTAINER_JSON','utf8'));(d.customizations?.vscode?.extensions||[]).forEach(e=>console.log(e))" 2>/dev/null)
else
	# Last resort: simple grep/sed approach (less reliable but works for simple JSON)
	EXTENSIONS=$(grep -A 20 '"extensions":' "$DEVCONTAINER_JSON" | grep -o '"[^"]*"' | sed 's/"//g' | grep -v '^extensions$' | grep -v '^\[' | grep -v '^\]' || true)
fi

if [ -z "$EXTENSIONS" ]; then
	echo "⚠️  Could not extract extensions from devcontainer.json"
	echo "   Extensions will be installed via .vscode/extensions.json recommendations"
	exit 0
fi

# Check if code command is available
if ! command -v code &> /dev/null; then
	echo "⚠️  VS Code CLI (code) not found. Extensions will be installed when VS Code connects."
	echo "   This is normal for DevPod - extensions will install automatically when the editor connects."
	exit 0
fi

# Install each extension
echo "$EXTENSIONS" | while IFS= read -r extension; do
	if [ -n "$extension" ]; then
		echo "📦 Installing ${extension}..."
		code --install-extension "${extension}" --force || echo "⚠️  Failed to install ${extension}"
	fi
done

echo "✅ VS Code extensions installation complete!"
