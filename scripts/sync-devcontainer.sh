#!/usr/bin/env bash
#
# sync-devcontainer.sh — pull this monorepo template's infra layer into another repo.
#
# Run this from INSIDE the target (apps) repo. It adds the template as a git
# remote, fetches it, and copies the template-owned infra paths over your tree
# while leaving apps/, libs/, and scripts/ project code untouched (project
# discovery is glob-based in .moon/workspace.yml and package.json, so the apps
# wiring is decoupled from this config).
#
# Nothing is committed for you. Every step is opt-in: you choose whether to run
# it, and review files are diffed before they are touched. Re-runnable any time
# you want to catch a downstream repo back up — just `git fetch` happens again.
#
# Usage:
#   scripts/sync-devcontainer.sh <template-url-or-path> [options]
#
#   <template-url-or-path>   git URL or local path of the template repo
#                            (e.g. https://github.com/you/devenv-template.git)
#
# Options:
#   --branch <ref>     template branch to sync from         (default: main)
#   --remote <name>    local remote name to use             (default: template)
#   --target-branch <name>   branch to create in this repo  (default: sync-devcontainer-<date>)
#   --dry-run          print every git/rm command, change nothing
#   --yes              auto-apply the safe groups without prompting
#                      (review + prune groups are STILL prompted individually)
#   -h | --help        show this help
#
# Customize the path lists below per sync — especially PRUNE_PATHS, which lists
# files the template has DELETED that a downstream repo should also delete.

set -euo pipefail

# ----------------------------------------------------------------------------
# What gets synced. Edit these lists to taste before/per run.
# ----------------------------------------------------------------------------

# Pure-template content directories. Mirrored: local copy is removed, then
# restored from the template, so files the template DELETED also disappear
# downstream. Before each wipe the script lists any local-only files about to be
# lost and asks again — so a stray project file here is never silently deleted.
#
# IMPORTANT: only list dirs that are ENTIRELY template-owned. Do NOT mirror dirs
# that mix template + project content (e.g. `openspec/`, whose changes/ + specs/
# are your project's; or whole agent dirs that also hold per-project config).
# Those go in REVIEW_PATHS (config files) or are left untouched (spec content).
MIRROR_PATHS=(
  .devcontainer
  .moon
  .husky
  .agents/skills
  .claude/commands
  .claude/skills
  .codex/skills
  .cursor/commands
  .cursor/rules
  .cursor/skills
  .gemini/skills
)

# Directories that may legitimately hold downstream-only files (extra CI
# workflows, editor settings). Additive: template files are written in, but
# nothing local is deleted. Template deletions inside these are reported only.
ADDITIVE_PATHS=(
  .github
  .vscode
)

# Single template-owned files — overwritten outright.
SAFE_FILES=(
  .claude/CLAUDE.md
  biome.jsonc
  .prototools
  init-host.sh
  tsconfig.base.json
  tsconfig.lib.base.json
  tsconfig.next.base.json
  tsconfig.stagehand.base.json
  tsconfig.start.base.json
  tsconfig.worker.base.json
  scripts/sync-devcontainer.sh
)

# Files that commonly carry per-project customization. Never overwritten
# blindly — you are shown the diff and decide apply / skip for each.
# NOTE: openspec/config.yaml is here (it holds your project context/rules);
# openspec/changes/ and openspec/specs/ are deliberately NOT synced at all.
REVIEW_PATHS=(
  package.json
  .gitignore
  README.md
  AGENTS.md
  CLAUDE.md
  GEMINI.md
  .claude/settings.json
  .codex/hooks.json
  .cursor/mcp.json
  .gemini/settings.json
  openspec/config.yaml
)

# Things the template has removed that a downstream repo should also delete.
# These are local paths to `git rm`. Update this list to match each template
# change you are adopting. (Prefilled with the OpenCode removal as an example.)
PRUNE_PATHS=(
  opencode.jsonc
  .opencode
)

# Never touched — regenerate or template-only artifacts.
#   bun.lock           -> regenerate with `bun install` after package.json settles
#   CHANGES.md         -> template-only changelog
#   init-new-project.sh-> template bootstrap script

# ----------------------------------------------------------------------------
# Args
# ----------------------------------------------------------------------------
TEMPLATE_SRC=""
BRANCH="main"
REMOTE="template"
TARGET_BRANCH=""
DRY_RUN=false
ASSUME_YES=false

usage() { sed -n '2,40p' "$0"; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --branch)        BRANCH="$2"; shift 2;;
    --remote)        REMOTE="$2"; shift 2;;
    --target-branch) TARGET_BRANCH="$2"; shift 2;;
    --dry-run)       DRY_RUN=true; shift;;
    --yes)           ASSUME_YES=true; shift;;
    -h|--help)       usage 0;;
    -*)              echo "Unknown option: $1" >&2; usage 1;;
    *)               TEMPLATE_SRC="$1"; shift;;
  esac
done

[ -n "$TEMPLATE_SRC" ] || { echo "error: template URL/path is required" >&2; usage 1; }
[ -n "$TARGET_BRANCH" ] || TARGET_BRANCH="sync-devcontainer-$(date +%Y%m%d)"

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
c_blue() { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }

run() {  # execute, or just print under --dry-run
  if $DRY_RUN; then printf '   + %s\n' "$*"; else "$@"; fi
}

confirm() {  # confirm "question" -> 0 if yes
  $ASSUME_YES && return 0
  local ans
  read -r -p "$1 [y/N] " ans </dev/tty || return 1
  [[ "$ans" =~ ^[Yy] ]]
}

ref()       { printf '%s/%s' "$REMOTE" "$BRANCH"; }
ref_type()  { git cat-file -t "$(ref):$1" 2>/dev/null || true; }   # tree | blob | empty

show_diff() {  # show_diff <path> : current tree vs template version
  local p="$1"
  if [ -e "$p" ]; then
    git --no-pager diff --no-index -- "$p" <(git show "$(ref):$p") 2>/dev/null || true
  else
    c_dim "  (new file — full template content:)"
    git --no-pager show "$(ref):$p" 2>/dev/null || true
  fi
}

# files present locally under a dir but absent from the template (one per line)
orphans_under() {
  local dir="$1" f
  [ -e "$dir" ] || return 0
  { git ls-files -- "$dir"; git ls-files --others --exclude-standard -- "$dir"; } \
    | sort -u | while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -z "$(ref_type "$f")" ] && printf '%s\n' "$f"
  done
}

# ----------------------------------------------------------------------------
# Preconditions
# ----------------------------------------------------------------------------
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "error: not inside a git repository. cd into the target repo first." >&2; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
  c_warn "Working tree is not clean. The sync stages changes on top of your current state."
  confirm "Continue anyway?" || { echo "Aborted."; exit 1; }
fi

c_blue "==> Template sync"
echo "   template src : $TEMPLATE_SRC"
echo "   from ref     : $(ref)"
echo "   into branch  : $TARGET_BRANCH"
$DRY_RUN && c_warn "   DRY RUN — no changes will be made"
echo

# ----------------------------------------------------------------------------
# 1. remote + fetch
# ----------------------------------------------------------------------------
c_blue "==> 1. Add remote '$REMOTE' and fetch"
if git remote get-url "$REMOTE" >/dev/null 2>&1; then
  existing="$(git remote get-url "$REMOTE")"
  if [ "$existing" != "$TEMPLATE_SRC" ]; then
    echo "   remote '$REMOTE' exists -> $existing"
    confirm "   point it at $TEMPLATE_SRC instead?" && run git remote set-url "$REMOTE" "$TEMPLATE_SRC"
  else
    c_dim "   remote '$REMOTE' already set"
  fi
else
  run git remote add "$REMOTE" "$TEMPLATE_SRC"
fi
run git fetch "$REMOTE" "$BRANCH"
git rev-parse --verify "$(ref)" >/dev/null 2>&1 || $DRY_RUN || {
  echo "error: $(ref) not found after fetch. Check --branch/--remote." >&2; exit 1; }
echo

# ----------------------------------------------------------------------------
# 2. branch
# ----------------------------------------------------------------------------
c_blue "==> 2. Create working branch '$TARGET_BRANCH'"
if git rev-parse --verify "$TARGET_BRANCH" >/dev/null 2>&1; then
  c_dim "   branch exists; switching to it"
  run git checkout "$TARGET_BRANCH"
else
  confirm "   create and switch to '$TARGET_BRANCH'?" && run git checkout -b "$TARGET_BRANCH" || c_dim "   staying on current branch"
fi
echo

# ----------------------------------------------------------------------------
# 3. mirrored dirs (template-owned; deletions propagate)
# ----------------------------------------------------------------------------
c_blue "==> 3. Mirror pure-template directories (template deletions propagate)"
printf '   %s\n' "${MIRROR_PATHS[@]}"
if confirm "   apply this group?"; then
  for p in "${MIRROR_PATHS[@]}"; do
    [ -n "$(ref_type "$p")" ] || { c_dim "   – absent in template, skip: $p"; continue; }
    orphans="$(orphans_under "$p")"
    if [ -n "$orphans" ]; then
      c_warn "   local-only files under '$p' that mirroring will DELETE:"
      printf '     %s\n' $orphans
      confirm "   ok to wipe + restore '$p' from template?" || { c_dim "   skipped $p"; continue; }
    fi
    run rm -rf -- "$p"
    run git checkout "$(ref)" -- "$p"
    echo "   ✓ $p"
  done
fi
echo

# ----------------------------------------------------------------------------
# 4. additive dirs (no local deletions; orphans reported)
# ----------------------------------------------------------------------------
c_blue "==> 4. Additive directories (template files written in; nothing local deleted)"
printf '   %s\n' "${ADDITIVE_PATHS[@]}"
if confirm "   apply this group?"; then
  for p in "${ADDITIVE_PATHS[@]}"; do
    [ -n "$(ref_type "$p")" ] || { c_dim "   – absent in template, skip: $p"; continue; }
    run git checkout "$(ref)" -- "$p"
    echo "   ✓ $p"
    orphans="$(orphans_under "$p")"
    [ -n "$orphans" ] && { c_warn "   orphans (template deleted these; left in place):"; printf '     %s\n' $orphans; }
  done
fi
echo

# ----------------------------------------------------------------------------
# 5. safe single files
# ----------------------------------------------------------------------------
c_blue "==> 5. Overwrite template-owned files"
printf '   %s\n' "${SAFE_FILES[@]}"
if confirm "   apply this group?"; then
  for p in "${SAFE_FILES[@]}"; do
    [ -n "$(ref_type "$p")" ] || { c_dim "   – absent in template, skip: $p"; continue; }
    run git checkout "$(ref)" -- "$p"
    echo "   ✓ $p"
  done
fi
echo

# ----------------------------------------------------------------------------
# 6. review files (diff + per-file decision)
# ----------------------------------------------------------------------------
c_blue "==> 6. Review files (likely customized — decide each)"
for p in "${REVIEW_PATHS[@]}"; do
  [ -n "$(ref_type "$p")" ] || { c_dim "   – absent in template, skip: $p"; continue; }
  if [ -e "$p" ] && git diff --no-index --quiet -- "$p" <(git show "$(ref):$p") 2>/dev/null; then
    c_dim "   = identical, skip: $p"; continue
  fi
  while true; do
    read -r -p "   $p — [a]pply template / [d]iff / [s]kip ? " a </dev/tty || a=s
    case "$a" in
      a|A) run git checkout "$(ref)" -- "$p"; echo "      ✓ applied"; break;;
      d|D) show_diff "$p";;
      s|S|"") c_dim "      skipped"; break;;
    esac
  done
done
echo

# ----------------------------------------------------------------------------
# 7. prune (template deletions to adopt)
# ----------------------------------------------------------------------------
c_blue "==> 7. Prune paths the template removed"
printf '   %s\n' "${PRUNE_PATHS[@]}"
for p in "${PRUNE_PATHS[@]}"; do
  [ -e "$p" ] || { c_dim "   – not present, skip: $p"; continue; }
  if confirm "   delete '$p' from this repo?"; then
    run git rm -r --quiet -- "$p" 2>/dev/null || run rm -rf -- "$p"
    echo "   ✓ removed $p"
  fi
done
echo

# ----------------------------------------------------------------------------
# Done
# ----------------------------------------------------------------------------
c_blue "==> Done. Next steps:"
cat <<'EOF'
   1. Review staged changes:   git status   &&   git diff --cached
   2. Reconcile package.json (deps/scripts/catalog) if you skipped it.
   3. Regenerate the lockfile: bun install
   4. Rebuild the devcontainer to pick up new on-create scripts.
   5. Commit when satisfied:   git commit -m "chore: sync devcontainer/infra from template"
   6. Re-run later to catch up again: this script re-fetches the remote each time.
EOF
