#!/usr/bin/env bash
# Common setup functions and environment configuration
# This file should be sourced by other setup scripts

# Function to setup Proto environment
setup_proto_env() {
    export PATH="$HOME/.proto/shims:$HOME/.proto/bin:$PATH"
    export PROTO_HOME="$HOME/.proto"
    # Add bun's global bin directory to PATH for globally installed packages
    export PATH="$HOME/.bun/bin:$PATH"
    # Add local bin for Claude Code native binary
    export PATH="$HOME/.local/bin:$PATH"
}
