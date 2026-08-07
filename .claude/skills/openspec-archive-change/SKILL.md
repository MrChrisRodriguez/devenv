---
name: openspec-archive-change
description: Archive a completed change in the experimental workflow. Use when the user wants to finalize and archive a change after implementation is complete.
---

<!-- Generated from @fission-ai/openspec by `openspec artifact-experimental-setup`. -->
<!-- Canonical rules live in AGENTS.md. Regenerate with `bun run rules:sync`; never edit by hand. -->

Archive a completed OpenSpec change by delegating to this repository's wrapper.

**Do not move directories, and do not call `openspec archive` yourself.** The vendor procedure this file replaces was a directory move with a date in it, and the CLI it wraps cannot be trusted to report what it did: it returns 0 after "Aborted. No files were changed.", and it applies the delta specs to `openspec/specs/**` *before* it checks whether the destination exists — then returns 0 when it does, leaving a half-applied tree that looks like a success.

**Steps**

1. Ask the operator which change to archive if they did not say. Run `openspec list --json` to show the active ones; never guess, and never auto-select.

2. Tell them to run, from the host:

   ```bash
   bash scripts/openspec/archive.sh --change <name>
   ```

   Add `--root <dir>` only when the same change name exists in more than one OpenSpec root, and `--dry-run` to see what would happen without changing anything.

3. Report what the wrapper printed. It is the authority on the outcome, including its refusals.

**What the wrapper owns, so you do not**

- Refusing a Codex Cloud task, a run inside the development container, and a checkout whose container is not ready.
- Refusing anything but the default branch, a dirty tree (including untracked files and `graphify-out/`), a missing `origin` ref, and a `HEAD` that is not exactly `origin/<default>` after a fresh fetch.
- Requiring an explicit `--change` the moment the selection is ambiguous, and refusing a change with remaining tasks.
- Choosing `--skip-specs` only when the change carries no delta specs at all.
- Pre-checking the archive destination in UTC, verifying the post-state after the CLI returns, and rolling the OpenSpec root back to `HEAD` on any failure.
- Re-running `bun run openspec:check` across every root, staging only the OpenSpec root, committing with the hooks enabled, and pushing — with a printed recovery path if the push is rejected.

**Never**

- Never run the wrapper with `--no-verify`, and never bypass it with a manual move or a direct CLI call.
- Never archive a change whose tasks are unfinished by "confirming past the warning". The wrapper has no such prompt on purpose.
