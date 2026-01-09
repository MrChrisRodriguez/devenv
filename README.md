Todo:
- figure out how to authenticate Opencode

tl;dr:
1. Reset git history
2. Authenticate Opencode

# 1. Reset git history

This is a template; you don't want to build on the existing git history. When you clone this be sure to wipe and reset git so you start fresh. You can do that by cloning the repository and then running the following commands:
```bash
git reset --hard HEAD
git clean -fdx
git push -f
```

# 2. Authenticate Opencode
```bash
opencode auth
```


--------------------------------

AI Tools:
- Openspec (https://github.com/fission-ai/openspec)
- Opencode (https://opencode.ai/)
- Claude Code
- Biome

Toolchain:
- Bun
- Proto
- Zsh
- Zinit
- Powerlevel10k
- Fzf
- Ripgrep
- Tree
- Unzip
- Xz-utils
- Git
- Github CLI
- Docker