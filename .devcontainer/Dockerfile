FROM mcr.microsoft.com/vscode/devcontainers/base:bookworm

# Install system packages (baked into image layer, not re-run on every container creation)
RUN apt-get update && apt-get install -y \
    bat \
    build-essential \
    ca-certificates \
    curl \
    dnsutils \
    fd-find \
    fzf \
    git \
    gzip \
    jq \
    less \
    nano \
    procps \
    ripgrep \
    sudo \
    tree \
    unzip \
    vim \
    wget \
    xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && ln -sf /usr/bin/batcat /usr/local/bin/bat

# Install git-delta
RUN ARCH=$(dpkg --print-architecture) \
    && wget -q "https://github.com/dandavison/delta/releases/download/0.18.2/git-delta_0.18.2_${ARCH}.deb" -O /tmp/delta.deb \
    && dpkg -i /tmp/delta.deb \
    && rm /tmp/delta.deb

# Switch to vscode user for user-scoped installs
USER vscode

# Install Zinit (zsh plugin manager) — clone directly to skip the interactive installer
RUN git clone https://github.com/zdharma-continuum/zinit.git \
    "${HOME}/.local/share/zinit/zinit.git"

USER root
