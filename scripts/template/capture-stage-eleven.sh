#!/usr/bin/env bash
# Host-only capture harness for the Stage 11 live acceptance items.
#
# One command id, two streams, one exit code, one duration — the shape every
# stage record in this program uses. It is a script rather than an inline
# invocation because the collector seals the exact argv, and an argv assembled
# in a shell history is one nobody can re-run.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_ROOT="${ROOT}/evidence/stage-11-release-run"
RUN_ID="${STAGE11_RUN_ID:?STAGE11_RUN_ID must be set}"

id="${1:?command id}"
shift

mkdir -p "${LOG_ROOT}"
start="$(python3 -c 'import time;print(int(time.time()*1000))')"
"$@" >"${LOG_ROOT}/${id}.stdout" 2>"${LOG_ROOT}/${id}.stderr"
code=$?
end="$(python3 -c 'import time;print(int(time.time()*1000))')"

{
  printf '# command-id: %s\n' "${id}"
  printf '# run: %s\n' "${RUN_ID}"
  printf '# exitCode: %s\n' "${code}"
  printf '# durationMs: %s\n' "$((end - start))"
} >>"${LOG_ROOT}/${id}.stdout"

printf '%s %s %s\n' "${id}" "${code}" "$((end - start))"
exit "${code}"
