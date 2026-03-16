FROM mcr.microsoft.com/vscode/devcontainers/base:bookworm

# Install system packages (baked into image layer, not re-run on every container creation)
RUN apt-get update && apt-get install -y \
    bat \
    build-essential \
    ca-certificates \
    curl \
    dnsutils \
    fzf \
    git \
    gzip \
    jq \
    less \
    ripgrep \
    tree \
    unzip \
    wget \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Install git-delta
RUN ARCH=$(dpkg --print-architecture) \
    && wget -q "https://github.com/dandavison/delta/releases/download/0.18.2/git-delta_0.18.2_${ARCH}.deb" -O /tmp/delta.deb \
    && dpkg -i /tmp/delta.deb \
    && rm /tmp/delta.deb

# Switch to vscode user for user-scoped installs
USER vscode

# Install Proto (tool version manager binary only — tools installed later via proto use)
RUN curl -fsSL https://moonrepo.dev/install/proto.sh | bash -s -- --yes

# Install Zinit (zsh plugin manager) — clone directly to skip the interactive installer
RUN git clone https://github.com/zdharma-continuum/zinit.git \
    "${HOME}/.local/share/zinit/zinit.git"

USER root
