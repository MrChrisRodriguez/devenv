# Stage 1 toolchain and dependency contract

Stage 1 replaces floating repository toolchain inputs with exact, reviewable
authorities. It does not yet move Proto into the image; that cache and ownership
cutover belongs to Stage 2.

## Sources of truth

| Concern | Sole authority |
|---|---|
| Proto-managed tools and community plugin locators | Root `.prototools` |
| Proto archive integrity by supported Linux architecture | `.devcontainer/proto-checksums.txt` |
| Project CLIs and shared packages | `package.json` root catalog plus `bun.lock` |
| Devcontainer features | `.devcontainer/devcontainer.json` plus `.devcontainer/devcontainer-lock.json` |
| Supported architectures and capability selection | `template-parameters.toml` |

Node is selected and is therefore owned by Proto. The competing Node feature
is absent. Caddy and k6 are not selected, so Stage 1 does not add them. Community
Proto plugin URLs contain immutable 40-character commits. The architecture-aware
installer verifies the archive checksum before extraction and rejects unsupported
architectures or malformed metadata.

Repository CLIs resolve from `/workspace/node_modules/.bin` before Proto or
global paths. The root lifecycle performs one frozen dependency install when a
lockfile exists. A newly rendered downstream fixture intentionally has no
template-owned `bun.lock`, so its first create generates the project-owned lock;
subsequent creates are frozen.

## Coupled package families

The catalog and lock treat these as atomic compatibility units:

- Cloudflare: Wrangler, Vite plugin, Workers Vitest pool, Miniflare, and workerd.
- Better Auth: `better-auth` and `@better-auth/core`.
- Forms: React Hook Form, resolvers, and Zod.
- Playwright: test package, runtime package, and core package.

Every root or generated non-peer consumer uses `catalog:`. Disabled fixture
profiles omit both the consumer and its catalog/override authority. TypeScript
aliases are rendered relative to the consuming config with `${configDir}` and
no active `baseUrl` or absolute source-project path.

## Validation and evidence

Run the complete Stage 1 gate with Bun:

```sh
bun install --frozen-lockfile
bun run toolchain:check
bun run template:validate
bun run template:test
bun run template:typecheck
bun run template:fixtures tmp/stage1-fixtures
bunx biome check --no-errors-on-unmatched .
```

`toolchain:check` validates the live repository and the strict
`evidence/stage-1-toolchain.json` record. The mutation suite proves that floating
catalog entries, direct consumer pins, family drift, duplicate resolutions,
mutable plugin URLs, feature digest drift, malformed or mismatched checksums,
`baseUrl`, absolute aliases, PATH inversion, secondary lockfiles, and disabled
family residue all fail closed. The evidence record binds the package, feature,
and checksum lock digests to the reviewed tree.

## Rollback

Stage 1 is one atomic merge bundle. Revert its merge commit with:

```sh
git revert -m 1 <stage-1-pr-merge-commit>
```

Do not revert only a catalog pin, `bun.lock`, one coupled-family member, the
feature lock, or the Proto checksum metadata. Those files jointly define the
contract.
