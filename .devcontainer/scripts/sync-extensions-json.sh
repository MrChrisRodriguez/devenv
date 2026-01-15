#!/usr/bin/env bash
# Helper script to sync .vscode/extensions.json from devcontainer.json
# Usage: .devcontainer/scripts/sync-extensions-json.sh

set -e

DEVCONTAINER_JSON=".devcontainer/devcontainer.json"
EXTENSIONS_JSON=".vscode/extensions.json"

if [ ! -f "$DEVCONTAINER_JSON" ]; then
	echo "❌ Error: $DEVCONTAINER_JSON not found"
	exit 1
fi

# Extract extensions using jq or node
if command -v jq &> /dev/null; then
	EXTENSIONS=$(jq -r '.customizations.vscode.extensions[]?' "$DEVCONTAINER_JSON" 2>/dev/null)
elif command -v node &> /dev/null; then
	EXTENSIONS=$(node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('$DEVCONTAINER_JSON','utf8'));(d.customizations?.vscode?.extensions||[]).forEach(e=>console.log(e))" 2>/dev/null)
else
	echo "❌ Error: Need jq or node to extract extensions"
	exit 1
fi

if [ -z "$EXTENSIONS" ]; then
	echo "⚠️  No extensions found in devcontainer.json"
	exit 1
fi

# Generate the JSON file
mkdir -p "$(dirname "$EXTENSIONS_JSON")"

cat > "$EXTENSIONS_JSON" << 'EOF'
{
	// NOTE: This file is auto-generated from .devcontainer/devcontainer.json
	// Source of truth: devcontainer.json -> customizations.vscode.extensions
	// Run .devcontainer/scripts/sync-extensions-json.sh to regenerate
	"recommendations": [
EOF

# Add each extension
echo "$EXTENSIONS" | while IFS= read -r ext; do
	if [ -n "$ext" ]; then
		echo "		\"$ext\"," >> "$EXTENSIONS_JSON"
	fi
done

# Remove trailing comma and close JSON
sed -i '$ s/,$//' "$EXTENSIONS_JSON"

cat >> "$EXTENSIONS_JSON" << 'EOF'
	]
}
EOF

echo "✅ Synced $EXTENSIONS_JSON from $DEVCONTAINER_JSON"
