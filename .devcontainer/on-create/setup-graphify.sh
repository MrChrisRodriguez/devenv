#!/usr/bin/env bash
set -e

echo "🕸️  Setting up Graphify (knowledge graph for AI assistants)..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access uv
setup_proto_env

# Install the graphifyy CLI. All project-scoped skill files and hooks
# (.claude/skills/graphify/, .codex/hooks.json, .gemini/settings.json,
# etc.) are committed to the repo — no
# `graphify install --project` needed here.
#
# The CLI lives at ~/.local/bin/graphify (where .codex/hooks.json references it).
# ~/.local is NOT volume-mounted, so this re-runs cleanly on every rebuild.

if ! command -v uv &> /dev/null; then
    echo "⚠️   uv not found on PATH (expected via Proto); skipping graphify install"
    return 0
fi

if command -v graphify &> /dev/null; then
    echo "ℹ️  graphify already installed at $(command -v graphify), skipping"
else
    echo "📦 Installing graphifyy[gemini] via uv..."
    # graphifyy pulls C/C++-extension deps (e.g. tree-sitter-dm) that ship no
    # prebuilt wheel for the proto-managed Python 3.14 on this arch, so uv
    # compiles them from source. Python 3.14's sysconfig hardcodes clang/clang++
    # for CC/CXX/LDSHARED/LDCXXSHARED, but this image ships only gcc/g++ — so the
    # build otherwise dies with "command 'clang' failed: No such file or
    # directory". When clang is absent, point the toolchain at gcc/g++.
    if ! command -v clang &> /dev/null && command -v gcc &> /dev/null; then
        echo "🔧 clang not found; building C extensions with gcc/g++"
        export CC="${CC:-gcc}"
        export CXX="${CXX:-g++}"
        export LDSHARED="${LDSHARED:-gcc -shared}"
        export LDCXXSHARED="${LDCXXSHARED:-g++ -shared}"
    fi
    # The `gemini` extra pulls in the `openai` SDK that graphify uses to talk
    # to Gemini's OpenAI-compatible endpoint. Without it, semantic extraction
    # fails the moment GEMINI_API_KEY or GOOGLE_API_KEY is set (which is the
    # default in this devcontainer's secrets file).
    uv tool install 'graphifyy[gemini]'
fi

echo "✅ Graphify setup complete!"
