#!/usr/bin/env bash
set -e

# Script to initialize a new project from this template
# Usage: ./init-new-project.sh [repository-name-or-url]

REPO_ARG="${1:-}"

echo "🔄 Initializing new project from template..."

# Remove existing git history
if [ -d ".git" ]; then
    echo "🗑️  Removing existing git history..."
    rm -rf .git
fi

# Remove template-only files that don't belong in downstream projects
rm -f bun.lock
rm -f CHANGES.md
rm -f init-host.sh

# Initialize new git repository
echo "📦 Initializing new git repository..."
git init

# Determine default branch name (main or master)
DEFAULT_BRANCH=$(git config --global init.defaultBranch 2>/dev/null || echo "main")
git checkout -b "$DEFAULT_BRANCH" 2>/dev/null || git checkout -b main 2>/dev/null || true

# Update DEVCONTAINER_PROJECT in devcontainer.json if a repo name was provided
if [ -n "$REPO_ARG" ]; then
    # Extract just the repo name (strip owner prefix if present)
    DEVCONTAINER_PROJECT="${REPO_ARG##*/}"
    DEVCONTAINER_PROJECT="${DEVCONTAINER_PROJECT%.git}"
    if [ -f ".devcontainer/devcontainer.json" ]; then
        echo "🔧 Setting DEVCONTAINER_PROJECT to \"$DEVCONTAINER_PROJECT\"..."
        sed -i.bak "s/\"DEVCONTAINER_PROJECT\": \"[^\"]*\"/\"DEVCONTAINER_PROJECT\": \"$DEVCONTAINER_PROJECT\"/" .devcontainer/devcontainer.json
        rm -f .devcontainer/devcontainer.json.bak
    fi
fi

# Self-delete — this is a one-time template bootstrap script
echo "🧹 Removing init script (one-time use)..."
rm -f "$0"

# Create initial commit
echo "📝 Creating initial commit..."
git add .
git commit -m "Initial commit" || {
    echo "⚠️  No changes to commit (this is okay if the repo is already clean)"
}

# Set up remote if repository name/URL provided
if [ -n "$REPO_ARG" ]; then
    # Check if GitHub CLI is available
    HAS_GH=false
    if command -v gh &> /dev/null; then
        # Check if authenticated
        if gh auth status &> /dev/null; then
            HAS_GH=true
        fi
    fi
    
    # Parse repository information
    REPO_OWNER=""
    REPO_NAME=""
    REMOTE_URL=""
    IS_GITHUB=false
    
    if [[ "$REPO_ARG" == http*github.com* ]] || [[ "$REPO_ARG" == git@github.com:* ]]; then
        # GitHub URL provided
        IS_GITHUB=true
        if [[ "$REPO_ARG" == https://github.com/* ]]; then
            # Extract owner/repo from https://github.com/owner/repo.git or https://github.com/owner/repo
            REPO_PATH="${REPO_ARG#https://github.com/}"
            REPO_PATH="${REPO_PATH%.git}"
            REPO_OWNER="${REPO_PATH%%/*}"
            REPO_NAME="${REPO_PATH#*/}"
        elif [[ "$REPO_ARG" == git@github.com:* ]]; then
            # Extract owner/repo from git@github.com:owner/repo.git
            REPO_PATH="${REPO_ARG#git@github.com:}"
            REPO_PATH="${REPO_PATH%.git}"
            REPO_OWNER="${REPO_PATH%%/*}"
            REPO_NAME="${REPO_PATH#*/}"
        fi
        REMOTE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
    elif [[ "$REPO_ARG" == */* ]]; then
        # Full repo name provided (owner/repo), assume GitHub
        IS_GITHUB=true
        REPO_OWNER="${REPO_ARG%%/*}"
        REPO_NAME="${REPO_ARG#*/}"
        REMOTE_URL="https://github.com/${REPO_ARG}.git"
    else
        # Just repository name provided, assume GitHub
        IS_GITHUB=true
        REPO_NAME="$REPO_ARG"
        if [ "$HAS_GH" = true ]; then
            # Get GitHub username from gh CLI
            REPO_OWNER=$(gh api user -q .login 2>/dev/null || echo "")
        fi
        if [ -z "$REPO_OWNER" ]; then
            # Fallback to git config
            REPO_OWNER=$(git config --global user.name 2>/dev/null || echo "")
        fi
        if [ -z "$REPO_OWNER" ]; then
            echo "⚠️  Could not determine GitHub username. Please provide full repository URL or username/repo-name"
            echo "   You can set up the remote manually with:"
            echo "   git remote add origin <your-repository-url>"
            exit 1
        fi
        REMOTE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
    fi
    
    # Create GitHub repository if it doesn't exist
    REPO_CREATED=false
    if [ "$IS_GITHUB" = true ] && [ "$HAS_GH" = true ] && [ -n "$REPO_OWNER" ] && [ -n "$REPO_NAME" ]; then
        echo "🔍 Checking if repository exists on GitHub..."
        if ! gh repo view "${REPO_OWNER}/${REPO_NAME}" &> /dev/null; then
            echo "📦 Creating new repository on GitHub: ${REPO_OWNER}/${REPO_NAME}"
            if gh repo create "${REPO_OWNER}/${REPO_NAME}" --private --source=. --remote=origin; then
                REPO_CREATED=true
                echo "✅ Repository created and remote configured!"
            else
                echo "⚠️  Failed to create repository. You may need to create it manually."
                echo "   Attempting to set up remote anyway..."
                # Only add remote if it doesn't already exist
                if ! git remote get-url origin &> /dev/null; then
                    git remote add origin "$REMOTE_URL" 2>/dev/null || true
                fi
            fi
        else
            echo "✅ Repository already exists on GitHub"
            # Only add remote if it doesn't already exist
            if ! git remote get-url origin &> /dev/null; then
                echo "🔗 Setting up remote repository: $REMOTE_URL"
                git remote add origin "$REMOTE_URL"
            else
                echo "🔗 Remote already configured"
            fi
        fi
    else
        if [ "$IS_GITHUB" = true ] && [ "$HAS_GH" = false ]; then
            echo "ℹ️  GitHub CLI not available or not authenticated. Skipping automatic repository creation."
            echo "   Install and authenticate GitHub CLI for automatic repo creation:"
            echo "   gh auth login"
        fi
        # Only add remote if it doesn't already exist
        if ! git remote get-url origin &> /dev/null; then
            echo "🔗 Setting up remote repository: $REMOTE_URL"
            git remote add origin "$REMOTE_URL"
        fi
    fi
    
    echo ""
    echo "✅ Git repository initialized!"
    if [ "$REPO_CREATED" = true ]; then
        echo ""
        echo "🎉 Repository created on GitHub!"
        echo "🚀 Ready to push! Run:"
        echo "   git push -u origin $DEFAULT_BRANCH"
    elif [ "$IS_GITHUB" = true ] && [ "$HAS_GH" = true ]; then
        echo ""
        echo "🚀 Ready to push! Run:"
        echo "   git push -u origin $DEFAULT_BRANCH"
    elif [ "$IS_GITHUB" = true ] && [ "$HAS_GH" = false ]; then
        echo ""
        echo "Next steps:"
        echo "  1. Create the repository on GitHub if you haven't already"
        echo "  2. Push your code:"
        echo "     git push -u origin $DEFAULT_BRANCH"
    else
        echo ""
        echo "Next steps:"
        echo "  1. Create the repository on your Git hosting service if you haven't already"
        echo "  2. Push your code:"
        echo "     git push -u origin $DEFAULT_BRANCH"
    fi
else
    echo ""
    echo "✅ Git repository initialized (no remote configured)"
    echo ""
    echo "To add a remote repository later:"
    echo "  git remote add origin <your-repository-url>"
    echo "  git push -u origin $DEFAULT_BRANCH"
fi

echo ""
echo "🎉 Project initialization complete!"
