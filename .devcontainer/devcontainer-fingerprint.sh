#!/usr/bin/env bash
set -euo pipefail

root="${1:-/workspace}"
bun_binary="${DEVCONTAINER_FINGERPRINT_BUN:-}"

if [ -z "$bun_binary" ]; then
	bun_binary="$(command -v bun || true)"
fi
if [ -z "$bun_binary" ] || [ "${bun_binary#/}" = "$bun_binary" ] || [ ! -x "$bun_binary" ]; then
	echo "Devcontainer fingerprint requires Bun" >&2
	exit 1
fi

exec "$bun_binary" - "$root" <<'BUN'
import { lstat, readdir, readlink } from "node:fs/promises";
import { join, posix, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "/workspace");
const entries = [];

function absolute(relativePath) {
	return join(root, ...relativePath.split("/"));
}

function sha256(value) {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function record(relativePath) {
	const path = absolute(relativePath);
	const metadata = await lstat(path);
	const mode = (metadata.mode & 0o7777).toString(8);

	if (metadata.isFile()) {
		entries.push({
			path: relativePath,
			type: "file",
			mode,
			digest: sha256(await Bun.file(path).arrayBuffer()),
		});
		return;
	}
	if (metadata.isSymbolicLink()) {
		entries.push({
			path: relativePath,
			type: "symlink",
			mode,
			digest: sha256(await readlink(path)),
		});
		return;
	}
	throw new Error(`Unsupported fingerprint input type: ${relativePath}`);
}

async function walk(relativeDirectory) {
	const names = await readdir(absolute(relativeDirectory));
	for (const name of names) {
		const relativePath = posix.join(relativeDirectory, name);
		const metadata = await lstat(absolute(relativePath));
		if (metadata.isDirectory()) await walk(relativePath);
		else await record(relativePath);
	}
}

try {
	await record(".dockerignore");
	await record(".prototools");
	await walk(".devcontainer");
} catch (error) {
	console.error(
		`Unable to fingerprint .dockerignore, .prototools, and .devcontainer: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
}

entries.sort((left, right) =>
	left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
);
const fingerprint = new Bun.CryptoHasher("sha256");
for (const entry of entries) {
	fingerprint.update(
		`${entry.path}\0${entry.type}\0${entry.mode}\0${entry.digest}\0`,
	);
}
console.log(fingerprint.digest("hex"));
BUN
