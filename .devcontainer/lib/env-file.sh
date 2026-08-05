#!/usr/bin/env bash
# Parse the devcontainer's documented single-line KEY=value format without
# evaluating file contents as shell code. Sourceable from bash and zsh.

devcontainer_env_parse_line() {
	local line="$1" source_name="$2" line_number="$3"
	local trimmed key value first last

	# Accept CRLF files but never carry the CR into a value.
	line="${line%$'\r'}"
	trimmed="${line#"${line%%[![:space:]]*}"}"
	case "$trimmed" in
		""|\#*) return 2 ;;
	esac

	case "$trimmed" in
		export[[:space:]]*) trimmed="${trimmed#export}" ;;
	esac
	trimmed="${trimmed#"${trimmed%%[![:space:]]*}"}"
	case "$trimmed" in
		*=*) ;;
		*)
			printf 'ERROR: invalid environment entry at %s:%s (expected KEY=value)\n' \
				"$source_name" "$line_number" >&2
			return 1
			;;
	esac

	key="${trimmed%%=*}"
	key="${key#"${key%%[![:space:]]*}"}"
	key="${key%"${key##*[![:space:]]}"}"
	case "$key" in
		""|[0-9]*|*[!a-zA-Z0-9_]*)
			printf 'ERROR: invalid environment variable name at %s:%s\n' \
				"$source_name" "$line_number" >&2
			return 1
			;;
	esac

	value="${trimmed#*=}"
	if [ -n "$value" ]; then
		first="${value%"${value#?}"}"
		last="${value#"${value%?}"}"
		case "$first" in
			"'"|'"')
				if [ "$last" != "$first" ] || [ "${#value}" -lt 2 ]; then
					printf 'ERROR: unterminated quoted value for %s at %s:%s\n' \
						"$key" "$source_name" "$line_number" >&2
					return 1
				fi
				value="${value#?}"
				value="${value%?}"
				;;
		esac
	fi

	DEVCONTAINER_ENV_KEY="$key"
	DEVCONTAINER_ENV_VALUE="$value"
	return 0
}

devcontainer_env_for_each() {
	local file="$1" callback="$2" label="${3:-$1}"
	local line line_number=0 parse_status

	[ -f "$file" ] || return 0
	while IFS= read -r line || [ -n "$line" ]; do
		line_number=$((line_number + 1))
		if devcontainer_env_parse_line "$line" "$label" "$line_number"; then
			"$callback" "$DEVCONTAINER_ENV_KEY" "$DEVCONTAINER_ENV_VALUE" || return
		else
			parse_status=$?
			[ "$parse_status" -eq 2 ] || return "$parse_status"
		fi
	done < "$file"
}
