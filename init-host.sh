#!/usr/bin/env bash
set -e

# Host machine setup for macOS
# Run this once on a fresh Mac before cloning and using the devcontainer template.

if [[ "$(uname)" != "Darwin" ]]; then
    echo "This script is for macOS only."
    exit 1
fi

echo "Setting up your Mac for devcontainer development..."
echo ""

# ── Xcode Command Line Tools (provides git, clang, etc.) ────────────────────
if ! xcode-select -p &>/dev/null; then
    echo "Installing Xcode Command Line Tools (this may take a few minutes)..."
    xcode-select --install
    echo "A dialog should have appeared. Click 'Install' and wait for it to finish."
    echo "Once it's done, re-run this script."
    exit 0
else
    echo "[ok] Xcode Command Line Tools"
fi

# ── Homebrew ─────────────────────────────────────────────────────────────────
if ! command -v brew &>/dev/null; then
    echo "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add brew to PATH for the rest of this script
    if [[ -f /opt/homebrew/bin/brew ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -f /usr/local/bin/brew ]]; then
        eval "$(/usr/local/bin/brew shellenv)"
    fi
else
    echo "[ok] Homebrew"
fi

# ── Git ──────────────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
    echo "Installing Git..."
    brew install git
else
    echo "[ok] Git ($(git --version | awk '{print $3}'))"
fi

# ── Docker Desktop ───────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
    echo "Installing Docker Desktop..."
    brew install --cask docker
    echo ""
    echo ">>> Open Docker Desktop from your Applications folder and let it finish starting up."
    echo "    You'll see a whale icon in your menu bar when it's ready."
    echo "    Press Enter to continue once Docker is running..."
    read -r
else
    echo "[ok] Docker ($(docker --version | awk '{print $3}' | tr -d ','))"
fi

# ── DevPod ───────────────────────────────────────────────────────────────────
if ! command -v devpod &>/dev/null; then
    echo "Installing DevPod..."
    brew install devpod
else
    echo "[ok] DevPod ($(devpod version 2>/dev/null || echo "installed"))"
fi

# ── IDE ──────────────────────────────────────────────────────────────────────
HAS_CURSOR=false
HAS_VSCODE=false
[[ -d "/Applications/Cursor.app" ]] && HAS_CURSOR=true
[[ -d "/Applications/Visual Studio Code.app" ]] && HAS_VSCODE=true

if [[ "$HAS_CURSOR" == false && "$HAS_VSCODE" == false ]]; then
    echo ""
    echo "You need a code editor. Which would you like to install?"
    echo "  1) Cursor  — AI-native editor built on VS Code"
    echo "  2) VS Code — Microsoft's free code editor"
    echo "  3) Both"
    echo "  4) Skip    — I'll install one myself"
    echo ""
    read -rp "Choice [1]: " IDE_CHOICE
    IDE_CHOICE="${IDE_CHOICE:-1}"

    case "$IDE_CHOICE" in
        1) brew install --cask cursor ;;
        2) brew install --cask visual-studio-code ;;
        3) brew install --cask cursor visual-studio-code ;;
        4) echo "Skipping IDE install." ;;
        *) echo "Unknown choice, skipping IDE install." ;;
    esac
else
    [[ "$HAS_CURSOR" == true ]] && echo "[ok] Cursor"
    [[ "$HAS_VSCODE" == true ]] && echo "[ok] VS Code"
fi

# ── GitHub CLI ───────────────────────────────────────────────────────────────
if ! command -v gh &>/dev/null; then
    echo "Installing GitHub CLI..."
    brew install gh
else
    echo "[ok] GitHub CLI ($(gh --version | head -1 | awk '{print $3}'))"
fi

if ! gh auth status &>/dev/null 2>&1; then
    echo ""
    echo "Logging in to GitHub..."
    gh auth login
else
    echo "[ok] GitHub CLI authenticated"
fi

# ── SSH Keys ─────────────────────────────────────────────────────────────────
if [[ ! -f "$HOME/.ssh/id_ed25519" && ! -f "$HOME/.ssh/id_rsa" ]]; then
    echo ""
    echo "No SSH keys found. Creating one now..."
    echo "This key lets you push code to GitHub without entering your password."
    echo ""

    GH_EMAIL=""
    if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
        GH_EMAIL=$(gh api user -q .email 2>/dev/null || echo "")
    fi

    if [[ -n "$GH_EMAIL" ]]; then
        read -rp "Email for SSH key [$GH_EMAIL]: " SSH_EMAIL
        SSH_EMAIL="${SSH_EMAIL:-$GH_EMAIL}"
    else
        read -rp "Email for SSH key: " SSH_EMAIL
    fi

    ssh-keygen -t ed25519 -C "$SSH_EMAIL" -f "$HOME/.ssh/id_ed25519"
    eval "$(ssh-agent -s)" &>/dev/null
    ssh-add "$HOME/.ssh/id_ed25519" 2>/dev/null

    # Add to GitHub if gh is available
    if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
        echo ""
        echo "Adding SSH key to your GitHub account..."
        gh ssh-key add "$HOME/.ssh/id_ed25519.pub" --title "$(hostname) ($(date +%Y-%m-%d))"
        echo "[ok] SSH key added to GitHub"
    else
        echo ""
        echo ">>> Add this key to GitHub manually:"
        echo "    1. Copy the key below"
        echo "    2. Go to https://github.com/settings/keys"
        echo "    3. Click 'New SSH key' and paste it in"
        echo ""
        cat "$HOME/.ssh/id_ed25519.pub"
        echo ""
    fi
else
    echo "[ok] SSH keys"
fi

# ── Host Directories ─────────────────────────────────────────────────────────
echo "Creating host directories for container mounts..."
mkdir -p "$HOME/.config/devcontainer/secrets.d"
chmod 700 "$HOME/.config/devcontainer/secrets.d"
mkdir -p "$HOME/.local/share/opencode"
echo "[ok] Host directories"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo " Host setup complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Clone the template:"
echo "     git clone https://github.com/MrChrisRodriguez/devenv.git my-project"
echo "     cd my-project"
echo ""
echo "  2. Initialize your project:"
echo "     ./init-new-project.sh my-project"
echo ""
echo "  3. Start the devcontainer:"
echo "     devpod up ."
echo ""
