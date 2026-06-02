#!/usr/bin/env bash
#
# sync-devcontainer.sh — catch a downstream repo up to this monorepo template,
# per-file, with content-aware classification and true 3-way merges.
#
# Run from INSIDE the target (apps) repo. It adds the template as a git remote,
# fetches it, and for every template-managed file decides what to do by COMPARING
# CONTENT — not by a hardcoded path list:
#
#   identical  — your file == template's current file            -> nothing to do
#   new        — template has a file you don't                   -> add it
#   pristine   — your file matches SOME past template version    -> replace wholesale
#                (i.e. you never hand-edited it; it's just stale)   (safe, automatic)
#   modified   — your file matches NO template version            -> 3-way merge if a
#                (you customized it)                                 baseline is known,
#                                                                    else diff + decide
#
# 3-way merges need a baseline (the template commit your repo was forked from).
# `init-new-project.sh` records it in `.template-ref`; this script reads it and
# updates it after each sync. With no baseline, modified files fall back to a
# diff + apply/keep prompt (nothing is overwritten without your say-so).
#
# Project content is never touched: apps/, libs/, scripts/ (except this script),
# graphify-out/, and openspec/changes|specs/ are excluded entirely.
#
# Nothing is committed for you. Re-runnable any time.
#
# Usage:
#   scripts/sync-devcontainer.sh [<template-url-or-path>] [options]
#     (URL optional if .template-ref records one)
#
# Options:
#   --branch <ref>          template branch to sync from        (default: main)
#   --remote <name>         local remote name                   (default: template)
#   --target-branch <name>  branch to create here   (default: sync-devcontainer-<date>)
#   --no-merge              never auto-merge; treat modified files as diff + decide
#   --dry-run               classify and report; change nothing
#   --yes                   auto-apply safe actions; keep-ours on un-mergeable files
#   -h | --help             show this help

set -euo pipefail

# Template-removed paths to also delete downstream that auto-detection might miss
# (e.g. locally-modified or untracked leftovers). Pristine template deletions are
# detected automatically; this is just an explicit safety list. Edit per sync.
PRUNE_PATHS=(
  opencode.jsonc
  .opencode
)

# Paths never synced (project content, regenerated artifacts, template-only files).
is_excluded() {
  case "$1" in
    scripts/sync-devcontainer.sh)              return 1 ;;  # always include
    apps/*|libs/*|scripts/*|graphify-out/*)    return 0 ;;
    openspec/changes/*|openspec/specs/*)       return 0 ;;
    bun.lock|CHANGES.md|init-new-project.sh|init-host.sh|.template-ref) return 0 ;;
    *)                                         return 1 ;;
  esac
}

# ----------------------------------------------------------------------------
# Args
# ----------------------------------------------------------------------------
TEMPLATE_SRC=""
BRANCH="main"
REMOTE="template"
TARGET_BRANCH=""
DRY_RUN=false
ASSUME_YES=false
NO_MERGE=false

usage() { sed -n '2,40p' "$0"; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --branch)        BRANCH="$2"; shift 2;;
    --remote)        REMOTE="$2"; shift 2;;
    --target-branch) TARGET_BRANCH="$2"; shift 2;;
    --no-merge)      NO_MERGE=true; shift;;
    --dry-run)       DRY_RUN=true; shift;;
    --yes)           ASSUME_YES=true; shift;;
    -h|--help)       usage 0;;
    -*)              echo "Unknown option: $1" >&2; usage 1;;
    *)               TEMPLATE_SRC="$1"; shift;;
  esac
done

[ -n "$TARGET_BRANCH" ] || TARGET_BRANCH="sync-devcontainer-$(date +%Y%m%d)"

# ----------------------------------------------------------------------------
# Helpers / colors
# ----------------------------------------------------------------------------
c_blue() { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
c_red()  { printf '\033[1;31m%s\033[0m\n' "$*"; }
c_grn()  { printf '\033[1;32m%s\033[0m\n' "$*"; }

confirm() {  # confirm "question" -> 0 if yes
  $ASSUME_YES && return 0
  local ans
  read -r -p "$1 [y/N] " ans </dev/tty || return 1
  [[ "$ans" =~ ^[Yy] ]]
}

ref()      { printf '%s/%s' "$REMOTE" "$BRANCH"; }
ref_type() { git cat-file -t "$(ref):$1" 2>/dev/null || true; }     # tree|blob|empty
blob_at()  { git rev-parse "$1:$2" 2>/dev/null || true; }            # blob_at <commit> <path>

# does <path> ever have blob <hash> across the synced branch's history?
in_template_history() {
  local p="$1" h="$2" c
  for c in $(git rev-list "$(ref)" -- "$p" 2>/dev/null || true); do
    [ "$(blob_at "$c" "$p")" = "$h" ] && return 0
  done
  return 1
}

# ----------------------------------------------------------------------------
# Preconditions + baseline
# ----------------------------------------------------------------------------
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "error: not inside a git repository. cd into the target repo first." >&2; exit 1; }

BASE_REF=""; BASE_URL=""
if [ -f .template-ref ]; then
  BASE_REF="$(sed -n 's/^ref=//p' .template-ref | head -1)"
  BASE_URL="$(sed -n 's/^url=//p' .template-ref | head -1)"
fi
[ -n "$TEMPLATE_SRC" ] || TEMPLATE_SRC="$BASE_URL"
[ -n "$TEMPLATE_SRC" ] || { echo "error: no template URL given and none in .template-ref" >&2; usage 1; }

if [ -n "$(git status --porcelain)" ]; then
  c_warn "Working tree is not clean. Changes are staged on top of your current state."
  confirm "Continue anyway?" || { echo "Aborted."; exit 1; }
fi

c_blue "==> Template sync"
echo "   template src : $TEMPLATE_SRC"
echo "   from ref     : $(ref)"
echo "   baseline     : ${BASE_REF:-<none — modified files fall back to review>}"
echo "   into branch  : $TARGET_BRANCH"
$DRY_RUN && c_warn "   DRY RUN — no changes will be made"
echo

# ----------------------------------------------------------------------------
# 1. remote + fetch
# ----------------------------------------------------------------------------
c_blue "==> 1. Add remote '$REMOTE' and fetch"
if git remote get-url "$REMOTE" >/dev/null 2>&1; then
  existing="$(git remote get-url "$REMOTE")"
  [ "$existing" = "$TEMPLATE_SRC" ] || { echo "   remote '$REMOTE' -> $existing"; \
    confirm "   repoint to $TEMPLATE_SRC?" && git remote set-url "$REMOTE" "$TEMPLATE_SRC"; }
else
  git remote add "$REMOTE" "$TEMPLATE_SRC"
fi
git fetch --quiet "$REMOTE" "$BRANCH"
# also fetch everything so the baseline commit (an ancestor) is available
git fetch --quiet "$REMOTE" || true
git rev-parse --verify "$(ref)" >/dev/null 2>&1 || {
  echo "error: $(ref) not found after fetch. Check --branch/--remote." >&2; exit 1; }
NEW_REF="$(git rev-parse "$(ref)")"
NEW_SHORT="$(git rev-parse --short "$(ref)")"

HAVE_BASE=false
if [ -n "$BASE_REF" ] && git cat-file -e "${BASE_REF}^{commit}" 2>/dev/null; then
  HAVE_BASE=true
  BASE_SHORT="$(git rev-parse --short "$BASE_REF" 2>/dev/null || echo "$BASE_REF")"
elif [ -n "$BASE_REF" ]; then
  c_warn "   baseline $BASE_REF not found in fetched history — 3-way merge disabled."
fi
$NO_MERGE && HAVE_BASE=false
echo

# ----------------------------------------------------------------------------
# 2. working branch
# ----------------------------------------------------------------------------
c_blue "==> 2. Working branch '$TARGET_BRANCH'"
if git rev-parse --verify "$TARGET_BRANCH" >/dev/null 2>&1; then
  c_dim "   exists; switching"; $DRY_RUN || git checkout --quiet "$TARGET_BRANCH"
else
  if confirm "   create and switch to '$TARGET_BRANCH'?"; then
    $DRY_RUN || git checkout --quiet -b "$TARGET_BRANCH"
  else c_dim "   staying on current branch"; fi
fi
echo

# ----------------------------------------------------------------------------
# scratch space for merges
# ----------------------------------------------------------------------------
TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
T_OURS="$TMPD/ours"; T_BASE="$TMPD/base"; T_THEIRS="$TMPD/theirs"

apply_theirs() {  # write template version of <path> into the tree + stage
  local p="$1"
  $DRY_RUN && return 0
  mkdir -p "$(dirname "$p")"
  git checkout "$(ref)" -- "$p"
}

# 3-way merge <path>; echoes "clean" or "conflict"; writes result unless dry-run
three_way() {
  local p="$1" base rc
  base="$(blob_at "$BASE_REF" "$p")"
  [ -n "$base" ] || { echo "nobase"; return; }
  cp "$p" "$T_OURS"
  git show "$BASE_REF:$p" > "$T_BASE" 2>/dev/null || { echo "nobase"; return; }
  git show "$(ref):$p"   > "$T_THEIRS"
  set +e
  git merge-file -L "ours ($p)" -L "base (template@$BASE_SHORT)" -L "theirs (template@$NEW_SHORT)" \
    "$T_OURS" "$T_BASE" "$T_THEIRS" >/dev/null 2>&1
  rc=$?
  set -e
  [ "$rc" -lt 128 ] || { echo "error"; return; }
  if ! $DRY_RUN; then
    cp "$T_OURS" "$p"
    [ "$rc" -eq 0 ] && git add "$p"   # stage clean merges; leave conflicts for resolution
  fi
  [ "$rc" -eq 0 ] && echo "clean" || echo "conflict"
}

# ----------------------------------------------------------------------------
# 3. classify + apply every template-managed file
# ----------------------------------------------------------------------------
c_blue "==> 3. Sync files (content-classified)"
declare -i n_same=0 n_new=0 n_pris=0 n_clean=0
CONFLICTS=(); REVIEW=()

while IFS= read -r f; do
  [ -n "$f" ] || continue
  is_excluded "$f" && continue
  theirs="$(blob_at "$(ref)" "$f")"; [ -n "$theirs" ] || continue

  if [ ! -e "$f" ]; then
    echo "   + new       $f"; apply_theirs "$f"; n_new+=1; continue
  fi
  cur="$(git hash-object -- "$f" 2>/dev/null || true)"
  if [ "$cur" = "$theirs" ]; then
    n_same+=1; continue
  fi
  if in_template_history "$f" "$cur"; then
    echo "   ~ stale     $f   (pristine — replacing)"; apply_theirs "$f"; n_pris+=1; continue
  fi

  # modified (you customized it)
  if $HAVE_BASE; then
    res="$(three_way "$f")"
    case "$res" in
      clean)    c_grn  "   ⇄ merged    $f"; n_clean+=1;;
      conflict) c_red  "   ⚠ CONFLICT  $f   (markers written — resolve manually)"; CONFLICTS+=("$f");;
      *)        c_warn "   ? review    $f   (no base for this file)"; REVIEW+=("$f");;
    esac
    continue
  fi

  # no baseline: decide interactively (or keep-ours under --yes)
  if $ASSUME_YES; then
    c_warn "   ? review    $f   (modified; kept your version)"; REVIEW+=("$f"); continue
  fi
  while true; do
    read -r -p "   modified: $f — [k]eep yours / [t]ake template / [d]iff / [s]kip ? " a </dev/tty || a=s
    case "$a" in
      t|T) apply_theirs "$f"; c_grn "      took template"; n_pris+=1; break;;
      d|D) git --no-pager diff --no-index -- "$f" <(git show "$(ref):$f") 2>/dev/null || true;;
      k|K|s|S|"") c_dim "      kept yours"; REVIEW+=("$f"); break;;
    esac
  done
done < <(git ls-tree -r --name-only "$(ref)")
echo

# ----------------------------------------------------------------------------
# 4. prune (template removed these; adopt the deletion)
# ----------------------------------------------------------------------------
c_blue "==> 4. Prune files the template removed"
declare -i n_pruned=0
prune_one() {  # prune_one <path> <auto?>
  local p="$1" auto="$2"
  $DRY_RUN && { echo "   - would remove $p"; n_pruned+=1; return; }
  if $auto || confirm "   delete '$p'?"; then
    git rm -r --quiet -- "$p" 2>/dev/null || rm -rf -- "$p"
    echo "   - removed   $p"; n_pruned+=1
  fi
}

# auto-detect: tracked files that were template-managed but are gone from template HEAD
while IFS= read -r f; do
  [ -n "$f" ] || continue
  is_excluded "$f" && continue
  [ -z "$(ref_type "$f")" ] || continue                   # still in template -> keep
  [ -n "$(git rev-list "$(ref)" -- "$f" 2>/dev/null)" ] || continue  # never template-managed -> keep
  cur="$(git hash-object -- "$f" 2>/dev/null || true)"
  if in_template_history "$f" "$cur"; then
    prune_one "$f" true                                   # pristine deletion -> safe auto
  else
    c_warn "   template removed '$f' but you modified it:"
    prune_one "$f" false
  fi
done < <(git ls-files)

# explicit safety list
for p in "${PRUNE_PATHS[@]}"; do
  [ -e "$p" ] || continue
  prune_one "$p" "$ASSUME_YES"
done
[ "$n_pruned" -eq 0 ] && c_dim "   (nothing to prune)"
echo

# ----------------------------------------------------------------------------
# 5. restamp baseline
# ----------------------------------------------------------------------------
c_blue "==> 5. Update .template-ref baseline -> $NEW_SHORT"
if ! $DRY_RUN; then
  {
    echo "# Template baseline for scripts/sync-devcontainer.sh — do not edit by hand."
    echo "# The sync script updates 'ref' to the new template commit after each sync."
    echo "url=$TEMPLATE_SRC"
    echo "ref=$NEW_REF"
  } > .template-ref
  git add .template-ref
fi
echo

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
c_blue "==> Summary"
echo "   up-to-date : $n_same"
echo "   added      : $n_new"
echo "   replaced   : $n_pris   (stale/pristine + 'take template')"
echo "   merged     : $n_clean  (clean 3-way)"
echo "   pruned     : $n_pruned"
echo "   conflicts  : ${#CONFLICTS[@]}"
echo "   review     : ${#REVIEW[@]}"
if [ "${#CONFLICTS[@]}" -gt 0 ]; then
  c_red "   resolve conflict markers in:"; printf '     %s\n' "${CONFLICTS[@]}"
fi
if [ "${#REVIEW[@]}" -gt 0 ]; then
  c_warn "   kept-yours / needs a look:"; printf '     %s\n' "${REVIEW[@]}"
fi
echo
c_blue "==> Next steps:"
cat <<'EOF'
   1. Resolve any conflict markers above, then `git add` those files.
   2. Review staged changes:   git status   &&   git diff --cached
   3. Reconcile package.json deps if it merged/changed, then: bun install
   4. Rebuild the devcontainer to pick up new on-create scripts.
   5. Commit:   git commit -m "chore: sync devcontainer/infra from template"
EOF
