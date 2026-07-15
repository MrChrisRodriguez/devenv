# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM mcr.microsoft.com/vscode/devcontainers/base:trixie@sha256:1a00517e89d3075f8c9dc8d9911404de0ff8991a4d71c62068573e9b016a89da AS stable_base

USER root

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bat \
		build-essential \
		ca-certificates \
		curl \
		dnsutils \
		fd-find \
		fzf \
		git \
		gzip \
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

# renovate: datasource=github-releases depName=dandavison/delta
ARG DELTA_VERSION=0.18.2
ARG DELTA_SHA256_AMD64=1658c7b61825d411b50734f34016101309e4b6e7f5799944cf8e4ac542cebd7f
ARG DELTA_SHA256_ARM64=937781aa7788e1510858743fff6c9a8b4a69fe0a22a7c8a69493e633227939a9
ARG TARGETARCH
RUN case "$TARGETARCH" in \
		amd64) DELTA_SHA256="$DELTA_SHA256_AMD64" ;; \
		arm64) DELTA_SHA256="$DELTA_SHA256_ARM64" ;; \
		*) echo "Unsupported git-delta architecture: $TARGETARCH" >&2; exit 1 ;; \
	esac \
	&& curl --fail --location --silent --show-error \
		--retry 3 --retry-all-errors --retry-max-time 180 \
		--connect-timeout 10 --max-time 180 \
		--output /tmp/delta.deb \
		"https://github.com/dandavison/delta/releases/download/${DELTA_VERSION}/git-delta_${DELTA_VERSION}_${TARGETARCH}.deb" \
	&& printf '%s  %s\n' "$DELTA_SHA256" /tmp/delta.deb | sha256sum --check --status - \
	&& dpkg -i /tmp/delta.deb \
	&& rm /tmp/delta.deb

# renovate: datasource=github-releases depName=rtk-ai/rtk
ARG RTK_VERSION=0.43.0
ARG RTK_SHA256_AMD64=ff8a1e7766496e175291a85aeca1dc97c9ff6df33e51e5893d1fbc78fea2a609
ARG RTK_SHA256_ARM64=5519f7ca12e5c143a609f0d28a0a77b97413a8dce31c2681f1a41c24519a8731
RUN case "$TARGETARCH" in \
		amd64) RTK_TARGET="x86_64-unknown-linux-musl"; RTK_SHA256="$RTK_SHA256_AMD64" ;; \
		arm64) RTK_TARGET="aarch64-unknown-linux-gnu"; RTK_SHA256="$RTK_SHA256_ARM64" ;; \
		*) echo "Unsupported RTK architecture: $TARGETARCH" >&2; exit 1 ;; \
	esac \
	&& curl --fail --location --silent --show-error \
		--retry 3 --retry-all-errors --retry-max-time 180 \
		--connect-timeout 10 --max-time 180 \
		--output /tmp/rtk.tar.gz \
		"https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-${RTK_TARGET}.tar.gz" \
	&& printf '%s  %s\n' "$RTK_SHA256" /tmp/rtk.tar.gz | sha256sum --check --status - \
	&& tar xzf /tmp/rtk.tar.gz -C /usr/local/bin/ \
	&& chmod +x /usr/local/bin/rtk \
	&& rm /tmp/rtk.tar.gz \
	&& chsh -s /usr/bin/zsh vscode \
	&& printf '%s\n' \
		'export PROTO_HOME="$HOME/.proto"' \
		'export PATH="/workspace/node_modules/.bin:$HOME/.proto/shims:$HOME/.proto/bin:$HOME/.local/bin:$PATH"' \
		> /etc/profile.d/devenv-path.sh \
	&& chmod 0644 /etc/profile.d/devenv-path.sh

USER vscode

ENV PROTO_HOME=/home/vscode/.proto
# capability:start playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/home/vscode/.payloads/browser
# capability:end playwright
ENV PATH="${PROTO_HOME}/shims:${PROTO_HOME}/bin:/home/vscode/.local/bin:${PATH}"

RUN mkdir -p \
	"${PROTO_HOME}" \
	"${HOME}/.bun/install/cache" \
	"${HOME}/.cache/uv" \
	"${HOME}/.local/bin" \
	"${HOME}/.payloads"

FROM stable_base AS proto_foundation

COPY --chown=vscode:vscode .devcontainer/prototools.foundation /tmp/devenv-proto-foundation/.prototools
COPY --chown=vscode:vscode \
	.devcontainer/install-proto.sh \
	.devcontainer/proto-checksums.txt \
	/tmp/devenv-proto-foundation/.devcontainer/

RUN bash /tmp/devenv-proto-foundation/.devcontainer/install-proto.sh \
	&& cd /tmp/devenv-proto-foundation \
	&& proto install --yes --config-mode local

FROM proto_foundation AS proto_auxiliary

COPY --chown=vscode:vscode .devcontainer/prototools.auxiliary /tmp/devenv-proto-auxiliary/.prototools
RUN cd /tmp/devenv-proto-auxiliary \
	&& proto install --yes --config-mode local

# capability:start graphify
FROM proto_foundation AS graphify_payload

# renovate: datasource=pypi depName=graphifyy
ARG GRAPHIFY_VERSION=0.9.16
RUN UV_TOOL_DIR="${HOME}/.payloads/graphify" \
	UV_TOOL_BIN_DIR="${HOME}/.payloads/graphify/bin" \
	CC="$(command -v gcc)" \
	CXX="$(command -v g++)" \
	uv tool install "graphifyy[gemini,sql]==${GRAPHIFY_VERSION}"
# capability:end graphify

# capability:start playwright
FROM proto_foundation AS playwright_browser

# renovate: datasource=npm depName=@playwright/test
ARG PLAYWRIGHT_VERSION=1.59.1
RUN --mount=type=cache,target=/home/vscode/.bun/install/cache,uid=1000,gid=1000 \
	bunx "playwright@${PLAYWRIGHT_VERSION}" install --only-shell chromium \
	&& find "${PLAYWRIGHT_BROWSERS_PATH}" -type f \
		\( -name headless_shell -o -name chrome-headless-shell \) \
		-perm /111 -print -quit | grep -q . \
	&& find "${PLAYWRIGHT_BROWSERS_PATH}" -type f \
		\( -name ffmpeg -o -name ffmpeg-linux \) \
		-perm /111 -print -quit | grep -q .
# capability:end playwright

# capability:start codex
FROM proto_foundation AS codex_payload

# renovate: datasource=npm depName=@openai/codex
ARG CODEX_VERSION=0.144.4
RUN BUN_INSTALL="${HOME}/.payloads/codex" \
	bun install -g "@openai/codex@${CODEX_VERSION}"
# capability:end codex

# capability:start gemini
FROM proto_foundation AS gemini_payload

# renovate: datasource=npm depName=@google/gemini-cli
ARG GEMINI_VERSION=0.50.0
RUN BUN_INSTALL="${HOME}/.payloads/gemini" \
	bun install -g "@google/gemini-cli@${GEMINI_VERSION}"
# capability:end gemini

# capability:start ccstatusline
FROM proto_foundation AS ccstatusline_payload

# renovate: datasource=npm depName=ccstatusline
ARG CCSTATUSLINE_VERSION=2.2.23
RUN BUN_INSTALL="${HOME}/.payloads/ccstatusline" \
	bun install -g "ccstatusline@${CCSTATUSLINE_VERSION}"
# capability:end ccstatusline

# capability:start context7
FROM proto_foundation AS context7_payload

# renovate: datasource=npm depName=@upstash/context7-mcp
ARG CONTEXT7_VERSION=3.2.3
RUN BUN_INSTALL="${HOME}/.payloads/context7" \
	bun install -g "@upstash/context7-mcp@${CONTEXT7_VERSION}"
# capability:end context7

# capability:start claude
FROM proto_foundation AS claude_payload

# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_VERSION=2.1.210
ARG CLAUDE_SHA256_AMD64=e7d2ceb53ed4c2ced1fe7fc1c6331c98dc5f7b4c9b2722d9c5fa3dd5dff6f719
ARG CLAUDE_SHA256_ARM64=84feb193c1d91f3b5eba836ed47c0e4dee953195abba950917c3e101eff174e8
# renovate: datasource=npm depName=node-gyp
ARG NODE_GYP_VERSION=13.0.1
ARG TARGETARCH
RUN case "$TARGETARCH" in \
		amd64) CLAUDE_PLATFORM="linux-x64"; CLAUDE_SHA256="$CLAUDE_SHA256_AMD64" ;; \
		arm64) CLAUDE_PLATFORM="linux-arm64"; CLAUDE_SHA256="$CLAUDE_SHA256_ARM64" ;; \
		*) echo "Unsupported Claude architecture: $TARGETARCH" >&2; exit 1 ;; \
	esac \
	&& curl --fail --location --silent --show-error \
		--retry 3 --retry-all-errors --retry-max-time 180 \
		--connect-timeout 10 --max-time 180 \
		"https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/${CLAUDE_PLATFORM}/claude" \
		-o "${HOME}/.local/bin/claude" \
	&& printf '%s  %s\n' "$CLAUDE_SHA256" "${HOME}/.local/bin/claude" | sha256sum --check --status - \
	&& chmod +x "${HOME}/.local/bin/claude" \
	&& BUN_INSTALL="${HOME}/.payloads/claude-tools" bun install -g "node-gyp@${NODE_GYP_VERSION}"
# capability:end claude

# capability:start claude_octopus
FROM proto_foundation AS octopus_payload

# renovate: datasource=git-refs depName=nyldn/claude-octopus packageName=https://github.com/nyldn/claude-octopus.git
ARG OCTOPUS_COMMIT=f42f34a8f9a7ee5b9324e8b2d23159878c132b02
ARG OCTOPUS_SHA256=64104245973939c1508babb4503bef56fdf455ffe57370758a8d07fbc0866263
RUN mkdir -p "${HOME}/.payloads/octopus" \
	&& curl --fail --location --silent --show-error \
		--retry 3 --retry-all-errors --retry-max-time 180 \
		--connect-timeout 10 --max-time 180 \
		"https://github.com/nyldn/claude-octopus/archive/${OCTOPUS_COMMIT}.tar.gz" \
		-o /tmp/octopus.tar.gz \
	&& printf '%s  %s\n' "$OCTOPUS_SHA256" /tmp/octopus.tar.gz | sha256sum --check --status - \
	&& tar xzf /tmp/octopus.tar.gz --strip-components=1 -C "${HOME}/.payloads/octopus" \
	&& rm /tmp/octopus.tar.gz \
	&& OCTOPUS_PAYLOAD="${HOME}/.payloads/octopus" bun -e \
		'const path = `${process.env.OCTOPUS_PAYLOAD}/.claude-plugin/marketplace.json`; const value = await Bun.file(path).json(); const plugin = value.plugins.find((entry) => entry.name === "octo"); if (!plugin) throw new Error("octo marketplace entry missing"); plugin.source = "."; value.plugins = [plugin]; await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);' \
	&& printf '%s\n%s\n' "$OCTOPUS_COMMIT" "$OCTOPUS_SHA256" > "${HOME}/.payloads/octopus/.devenv-source"
# capability:end claude_octopus

# capability:start claude_warp
FROM proto_foundation AS warp_payload

# renovate: datasource=git-refs depName=warpdotdev/claude-code-warp packageName=https://github.com/warpdotdev/claude-code-warp.git
ARG WARP_COMMIT=58c823da195346a7e6645fd2d9484d0e38db6bc2
ARG WARP_SHA256=054607a80b7eb5571615925a6991082091d063b4eac591499177716421f76557
RUN mkdir -p "${HOME}/.payloads/warp" \
	&& curl --fail --location --silent --show-error \
		--retry 3 --retry-all-errors --retry-max-time 180 \
		--connect-timeout 10 --max-time 180 \
		"https://github.com/warpdotdev/claude-code-warp/archive/${WARP_COMMIT}.tar.gz" \
		-o /tmp/warp.tar.gz \
	&& printf '%s  %s\n' "$WARP_SHA256" /tmp/warp.tar.gz | sha256sum --check --status - \
	&& tar xzf /tmp/warp.tar.gz --strip-components=1 -C "${HOME}/.payloads/warp" \
	&& rm /tmp/warp.tar.gz \
	&& printf '%s\n%s\n' "$WARP_COMMIT" "$WARP_SHA256" > "${HOME}/.payloads/warp/.devenv-source" \
	&& cp "${HOME}/.payloads/warp/.devenv-source" "${HOME}/.payloads/warp/plugins/warp/.devenv-source"
# capability:end claude_warp

FROM stable_base AS shell_payload

# renovate: datasource=git-refs depName=zdharma-continuum/zinit packageName=https://github.com/zdharma-continuum/zinit.git
ARG ZINIT_COMMIT=e347224fb5fe77308cff9f59fbe2acca70d0a6db
ARG ZINIT_SHA256=96380971046cf82765dc02822dd6acf993bfce3e3a4eaf46a3f42eafdac37434
RUN mkdir -p "${HOME}/.local/share/zinit/zinit.git" \
	&& curl --fail --location --silent --show-error \
		--retry 3 --retry-all-errors --retry-max-time 180 \
		--connect-timeout 10 --max-time 120 \
		"https://github.com/zdharma-continuum/zinit/archive/${ZINIT_COMMIT}.tar.gz" \
		-o /tmp/zinit.tar.gz \
	&& printf '%s  %s\n' "$ZINIT_SHA256" /tmp/zinit.tar.gz | sha256sum --check --status - \
	&& tar xzf /tmp/zinit.tar.gz --strip-components=1 -C "${HOME}/.local/share/zinit/zinit.git" \
	&& rm /tmp/zinit.tar.gz

FROM proto_auxiliary AS development

# capability:start graphify
COPY --link --from=graphify_payload --chown=1000:1000 /home/vscode/.payloads/graphify /home/vscode/.payloads/graphify
# capability:end graphify
# capability:start codex
COPY --link --from=codex_payload --chown=1000:1000 /home/vscode/.payloads/codex /home/vscode/.payloads/codex
# capability:end codex
# capability:start gemini
COPY --link --from=gemini_payload --chown=1000:1000 /home/vscode/.payloads/gemini /home/vscode/.payloads/gemini
COPY --link --chown=1000:1000 --chmod=0755 .devcontainer/configs/gemini-watchdog /home/vscode/.local/bin/gemini
# capability:end gemini
# capability:start ccstatusline
COPY --link --from=ccstatusline_payload --chown=1000:1000 /home/vscode/.payloads/ccstatusline /home/vscode/.payloads/ccstatusline
# capability:end ccstatusline
# capability:start context7
COPY --link --from=context7_payload --chown=1000:1000 /home/vscode/.payloads/context7 /home/vscode/.payloads/context7
# capability:end context7
# capability:start claude
COPY --link --from=claude_payload --chown=1000:1000 /home/vscode/.payloads/claude-tools /home/vscode/.payloads/claude-tools
COPY --link --from=claude_payload --chown=1000:1000 /home/vscode/.local/bin/claude /home/vscode/.local/bin/claude
# capability:end claude
# capability:start claude_octopus
COPY --link --from=octopus_payload --chown=1000:1000 /home/vscode/.payloads/octopus /home/vscode/.payloads/octopus
# capability:end claude_octopus
# capability:start claude_warp
COPY --link --from=warp_payload --chown=1000:1000 /home/vscode/.payloads/warp /home/vscode/.payloads/warp
# capability:end claude_warp
COPY --link --from=shell_payload --chown=1000:1000 /home/vscode/.local/share/zinit /home/vscode/.local/share/zinit

# capability:start graphify
RUN ln -s ../../.payloads/graphify/bin/graphify "${HOME}/.local/bin/graphify" \
	&& ln -s ../../.payloads/graphify/bin/graphify-mcp "${HOME}/.local/bin/graphify-mcp"
# capability:end graphify
# capability:start codex
RUN ln -s ../../.payloads/codex/bin/codex "${HOME}/.local/bin/codex"
# capability:end codex
# capability:start ccstatusline
RUN ln -s ../../.payloads/ccstatusline/bin/ccstatusline "${HOME}/.local/bin/ccstatusline"
# capability:end ccstatusline
# capability:start context7
RUN ln -s ../../.payloads/context7/bin/context7-mcp "${HOME}/.local/bin/context7-mcp"
# capability:end context7
# capability:start claude
RUN ln -s ../../.payloads/claude-tools/bin/node-gyp "${HOME}/.local/bin/node-gyp"
# capability:end claude
RUN printf '%s\n' \
		'if [ -n "${BASH_VERSION:-}" ] && [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi' \
		'export PROTO_HOME="$HOME/.proto"' \
		'export PATH="/workspace/node_modules/.bin:$HOME/.proto/shims:$HOME/.proto/bin:$HOME/.local/bin:$PATH"' \
		> "${HOME}/.profile" \
	&& printf '%s\n' 'source "$HOME/.profile"' > "${HOME}/.zprofile"

USER root
COPY --chown=vscode:vscode .prototools /home/vscode/.prototools
COPY .dockerignore /tmp/devenv-definition/.dockerignore
COPY .prototools /tmp/devenv-definition/.prototools
COPY .devcontainer /tmp/devenv-definition/.devcontainer
RUN mkdir -p /usr/local/share/devenv-image \
	&& install -m 0555 /tmp/devenv-definition/.devcontainer/devcontainer-fingerprint.sh /usr/local/share/devenv-image/devcontainer-fingerprint.sh \
	&& install -m 0555 /tmp/devenv-definition/.devcontainer/on-create/setup-proto.sh /usr/local/share/devenv-image/setup-proto.sh \
	&& sha256sum /tmp/devenv-definition/.prototools | awk '{print $1}' > /usr/local/share/devenv-image/prototools.sha256 \
	&& bash /usr/local/share/devenv-image/devcontainer-fingerprint.sh /tmp/devenv-definition > /usr/local/share/devenv-image/definition.sha256 \
	&& chmod 0444 /usr/local/share/devenv-image/*.sha256 \
	&& rm -rf /tmp/devenv-definition

USER vscode
ENV PATH="/workspace/node_modules/.bin:${PROTO_HOME}/shims:${PROTO_HOME}/bin:/home/vscode/.local/bin:${PATH}"
WORKDIR /workspace

# capability:start playwright
FROM development AS development_browser

USER root
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		fonts-freefont-ttf \
		fonts-ipafont-gothic \
		fonts-liberation \
		fonts-noto-color-emoji \
		fonts-tlwg-loma-otf \
		fonts-unifont \
		fonts-wqy-zenhei \
		libasound2t64 \
		libatk-bridge2.0-0t64 \
		libatk1.0-0t64 \
		libatspi2.0-0t64 \
		libcairo2 \
		libcups2t64 \
		libdbus-1-3 \
		libdrm2 \
		libfontconfig1 \
		libfreetype6 \
		libgbm1 \
		libglib2.0-0t64 \
		libnspr4 \
		libnss3 \
		libpango-1.0-0 \
		libx11-6 \
		libxcb1 \
		libxcomposite1 \
		libxdamage1 \
		libxext6 \
		libxfixes3 \
		libxkbcommon0 \
		libxrandr2 \
	&& rm -rf /var/lib/apt/lists/*
COPY --link --from=playwright_browser --chown=1000:1000 /home/vscode/.payloads/browser /home/vscode/.payloads/browser
USER vscode
# capability:end playwright
