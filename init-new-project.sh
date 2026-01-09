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

# Initialize new git repository
echo "📦 Initializing new git repository..."
git init

# Determine default branch name (main or master)
DEFAULT_BRANCH=$(git config --global init.defaultBranch 2>/dev/null || echo "main")
git checkout -b "$DEFAULT_BRANCH" 2>/dev/null || git checkout -b main 2>/dev/null || true

# Create initial commit
echo "📝 Creating initial commit..."
git add .
git commit -m "Initial commit" || {
    echo "⚠️  No changes to commit (this is okay if the repo is already clean)"
}

# Set up remote if repository name/URL provided
if [ -n "$REPO_ARG" ]; then
    # Determine the remote URL
    if [[ "$REPO_ARG" == http* ]] || [[ "$REPO_ARG" == git@* ]]; then
        # Full URL provided
        REMOTE_URL="$REPO_ARG"
    else
        # Just repository name provided, assume GitHub
        # Check if it's already a full repo name (user/repo) or just a name
        if [[ "$REPO_ARG" == */* ]]; then
            REMOTE_URL="https://github.com/${REPO_ARG}.git"
        else
            # Try to get GitHub username from git config
            GITHUB_USER=$(git config --global user.name 2>/dev/null || echo "")
            if [ -z "$GITHUB_USER" ]; then
                echo "⚠️  Could not determine GitHub username. Please provide full repository URL or username/repo-name"
                echo "   You can set up the remote manually with:"
                echo "   git remote add origin <your-repository-url>"
                exit 1
            fi
            REMOTE_URL="https://github.com/${GITHUB_USER}/${REPO_ARG}.git"
        fi
    fi
    
    echo "🔗 Setting up remote repository: $REMOTE_URL"
    git remote add origin "$REMOTE_URL"
    
    echo ""
    echo "✅ Git repository initialized!"
    echo ""
    echo "Next steps:"
    echo "  1. Create the repository on GitHub/GitLab/etc if you haven't already"
    echo "  2. Push your code:"
    echo "     git push -u origin $DEFAULT_BRANCH"
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
