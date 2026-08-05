#!/usr/bin/env bash
set -euo pipefail

WORKSPACE_ROOT="${DEVCONTAINER_WORKSPACE_ROOT:-/workspace}"
CONFIG_ROOT="$WORKSPACE_ROOT/.devcontainer/configs"

optional_shell_step() {
	local label="$1"
	shift
	if "$@"; then
		return 0
	fi
	echo "⚠️  Optional shell setup failed: $label"
	return 0
}

backup_if_present() {
	local file="$1"
	if [ -f "$file" ]; then
		cp "$file" "${file}.backup"
	fi
}

verify_image_zinit() {
	local zinit_home="${XDG_DATA_HOME:-${HOME}/.local/share}/zinit/zinit.git"
	if [ ! -r "$zinit_home/zinit.zsh" ]; then
		echo "❌ The pinned image-owned Zinit payload is missing: $zinit_home/zinit.zsh" >&2
		echo "   Rebuild/recreate the devcontainer; shell payloads are never repaired at runtime." >&2
		return 1
	fi
}

install_core_shell_config() {
	local file
	for file in \
		"$WORKSPACE_ROOT/.devcontainer/environment.sh" \
		"$WORKSPACE_ROOT/.devcontainer/lib/env-file.sh" \
		"$CONFIG_ROOT/.shell_common" \
		"$CONFIG_ROOT/.bashrc" \
		"$CONFIG_ROOT/.zshrc"; do
		[ -r "$file" ] || {
			echo "❌ Required shell environment file is missing: $file" >&2
			return 1
		}
	done

	bash -n "$WORKSPACE_ROOT/.devcontainer/environment.sh"
	bash -n "$WORKSPACE_ROOT/.devcontainer/lib/env-file.sh"
	bash -n "$CONFIG_ROOT/.shell_common"
	bash -n "$CONFIG_ROOT/.bashrc"
	zsh -n "$CONFIG_ROOT/.zshrc"

	backup_if_present "$HOME/.bashrc"
	backup_if_present "$HOME/.zshrc"
	install -m 0644 "$CONFIG_ROOT/.bashrc" "$HOME/.bashrc"
	install -m 0644 "$CONFIG_ROOT/.zshrc" "$HOME/.zshrc"
	cmp -s "$CONFIG_ROOT/.bashrc" "$HOME/.bashrc"
	cmp -s "$CONFIG_ROOT/.zshrc" "$HOME/.zshrc"
	echo "✅ Core bash/zsh environment entrypoints installed and verified"
}

setup_p10k() {
	if [ ! -f "$HOME/.p10k.zsh" ]; then
		cp "$CONFIG_ROOT/.p10k.zsh" "$HOME/.p10k.zsh"
	fi
}

setup_history() {
	sudo mkdir -p /commandhistory &&
		sudo touch /commandhistory/.bash_history /commandhistory/.zsh_history &&
		sudo chown -R vscode:vscode /commandhistory &&
		chmod 755 /commandhistory &&
		chmod 644 /commandhistory/.bash_history /commandhistory/.zsh_history
}

setup_moon_completions() {
	command -v moon >/dev/null 2>&1 || return 0
	mkdir -p "$HOME/.config/moon" &&
		moon completions --shell bash > "$HOME/.config/moon/completions.bash" &&
		moon completions --shell zsh > "$HOME/.config/moon/completions.zsh"
}

setup_proto_completions() {
	command -v proto >/dev/null 2>&1 || return 0
	mkdir -p "$HOME/.config/proto" &&
		proto completions --shell bash > "$HOME/.config/proto/completions.bash" &&
		proto completions --shell zsh > "$HOME/.config/proto/completions.zsh"
}

# Hard steps. The shell entrypoints ARE the environment contract: a .zshrc that
# fails to install (or fails `zsh -n`) leaves every later shell without secrets,
# PATH, or Proto, so these failures must abort on-create rather than warn. The
# Zinit check stays hard for the same reason it always was — shell payloads are
# image-owned and are never repaired at runtime.
echo "🔧 Installing core shell environment..."
verify_image_zinit
install_core_shell_config

# Everything below is decorative or persistent UX. Failures are bounded
# warnings after the environment contract has already been verified.
optional_shell_step "Powerlevel10k configuration" setup_p10k
optional_shell_step "persistent command history" setup_history
optional_shell_step "Moon completions" setup_moon_completions
optional_shell_step "Proto completions" setup_proto_completions
