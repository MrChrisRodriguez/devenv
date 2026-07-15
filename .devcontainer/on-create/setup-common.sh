#!/usr/bin/env bash
# Common setup functions and environment configuration
# This file should be sourced by other setup scripts

# Function to setup Proto environment
setup_proto_env() {
	export PATH="/workspace/node_modules/.bin:$HOME/.local/bin:$HOME/.proto/shims:$HOME/.proto/bin:$HOME/.bun/bin:$PATH"
    export PROTO_HOME="$HOME/.proto"
}

install_workspace_dependencies() {
	if [ -f /workspace/bun.lock ]; then
		(cd /workspace && bun install --frozen-lockfile)
	else
		# Newly rendered projects intentionally create their first lock locally.
		(cd /workspace && bun install)
	fi
}
