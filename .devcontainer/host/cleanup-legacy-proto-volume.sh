#!/usr/bin/env bash
set -euo pipefail

dry_run=false
if [ "${1:-}" = "--dry-run" ]; then
	dry_run=true
	shift
fi

if [ "$#" -ne 1 ]; then
	echo "usage: cleanup-legacy-proto-volume.sh [--dry-run] <exact-devcontainer-id>" >&2
	exit 2
fi

devcontainer_id="${1:-}"
if ! printf '%s' "$devcontainer_id" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]{5,127}$'; then
	echo "usage: cleanup-legacy-proto-volume.sh [--dry-run] <exact-devcontainer-id>" >&2
	exit 2
fi

volume="proto-home-${devcontainer_id}"
if ! command -v docker >/dev/null 2>&1; then
	echo "Legacy Proto volume cleanup requires Docker on the host" >&2
	exit 1
fi

if ! volumes="$(docker volume ls --format '{{.Name}}')"; then
	echo "Unable to query Docker volumes; verify that the Docker daemon is available" >&2
	exit 1
fi
if ! printf '%s\n' "$volumes" | grep -Fxq "$volume"; then
	echo "Legacy Proto volume does not exist: $volume"
	exit 0
fi

if ! attached="$(docker ps -aq --filter "volume=${volume}")"; then
	echo "Unable to check whether legacy Proto volume $volume is attached" >&2
	exit 1
fi
if [ -n "$attached" ]; then
	echo "Refusing to remove attached legacy Proto volume $volume (containers: $attached)" >&2
	exit 1
fi

if $dry_run; then
	echo "Would remove exact unattached legacy Proto volume: $volume"
else
	docker volume rm "$volume"
fi
