#!/usr/bin/env bash
set -e

# Function to setup completions for a tool
setup_completions() {
    local tool="$1"
    local tool_name="$2"
    
    echo "🚀 Setting up $tool_name completions..."
    if command -v "$tool" &> /dev/null; then
        mkdir -p ~/.config/"$tool"
        "$tool" completions --shell bash > ~/.config/"$tool"/completions.bash
        "$tool" completions --shell zsh > ~/.config/"$tool"/completions.zsh
        echo "✅ $tool_name completions generated"
    else
        echo "⚠️  $tool_name not found, skipping completions setup"
    fi
}

# Configure bash
echo "🔧 Configuring bash..."
# Always use our template for consistent configuration
if [ -f "$HOME/.bashrc" ]; then
    echo "📝 Backing up existing .bashrc to .bashrc.backup..."
    cp "$HOME/.bashrc" "$HOME/.bashrc.backup"
fi
echo "📝 Installing our .bashrc template..."
cp "/workspace/.devcontainer/configs/.bashrc" "$HOME/.bashrc"

# Setup Zsh (Zinit is pre-installed in the Docker image)
echo "🔧 Setting up Zsh configuration..."

# Configure zsh
echo "🔧 Configuring zsh..."
# Always use our template for consistent configuration  
if [ -f "$HOME/.zshrc" ]; then
    echo "📝 Backing up existing .zshrc to .zshrc.backup..."
    cp "$HOME/.zshrc" "$HOME/.zshrc.backup"
fi
echo "📝 Installing our .zshrc template..."
cp "/workspace/.devcontainer/configs/.zshrc" "$HOME/.zshrc"

# Create a basic p10k config if it doesn't exist
if [ ! -f "$HOME/.p10k.zsh" ]; then
    echo "🎨 Creating basic Powerlevel10k configuration..."
    cp "/workspace/.devcontainer/configs/.p10k.zsh" "$HOME/.p10k.zsh"
fi


# PERSISTENT COMMAND HISTORY

echo "📚 Setting up persistent command history..."
# Create the command history directory if it doesn't exist
sudo mkdir -p /commandhistory
# Create history files for both bash and zsh
sudo touch /commandhistory/.bash_history
sudo touch /commandhistory/.zsh_history
# Set ownership to vscode user
sudo chown -R vscode:vscode /commandhistory
# Set appropriate permissions
chmod 755 /commandhistory
chmod 644 /commandhistory/.bash_history
chmod 644 /commandhistory/.zsh_history
echo "✅ Persistent command history directory setup complete"

# APP-SPECIFIC CONFIGURATION
# Moon completions
echo "🚀 Setting up Moon completions..."
if command -v moon &> /dev/null; then
    mkdir -p ~/.config/moon
    moon completions --shell bash > ~/.config/moon/completions.bash
    moon completions --shell zsh > ~/.config/moon/completions.zsh
    echo "✅ Moon completions generated"
else
    echo "⚠️  Moon not found, skipping completions setup"
fi

# Proto completions
echo "🚀 Setting up Proto completions..."
if command -v proto &> /dev/null; then
    mkdir -p ~/.config/proto
    proto completions --shell bash > ~/.config/proto/completions.bash
    proto completions --shell zsh > ~/.config/proto/completions.zsh
    echo "✅ Proto completions generated"
else
    echo "⚠️  Proto not found, skipping completions setup"
fi