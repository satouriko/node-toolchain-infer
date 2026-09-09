# node-toolchain-infer

Infer a project's Node.js and npm, pnpm or Yarn versions from explicit inputs, nearby project files and measured lockfile compatibility. Requires **Node.js ≥18**. Bun and Deno are outside the scope.

[中文](README.zh-CN.md) · [Website and calculator](https://satouriko.github.io/node-toolchain-infer/) · [Maintenance procedure](maintenance/README.md) · [Human/AI maintenance instructions](maintenance/update-compatibility.prompt.md)

Known installation bugs can fail a frozen-install test even when the lock format is semantically compatible. Reviewed exceptions preserve those failed observations and keep compatible versions selectable; `known-package-manager-bug` warns when one is selected. Full test provenance stays in the maintenance repository, outside the npm package.

Explicit versions and semver ranges follow the same rule: a retained API/CLI or project-file declaration can admit matching prereleases for its own tool. Ranges use standard semver matching. Both `pnpm@10.0.0-rc.1` and `pnpm@>=10.0.0-rc.1 <10.0.0` can select a pnpm prerelease. Inferring Node from that manager still selects **stable versions only** unless Node has its own explicit declaration admitting prereleases. Lockfile inference, local fallback without a matching declaration, release statistics and compatibility maintenance remain stable-only.

```ts
import { infer } from 'node-toolchain-infer'

const result = await infer({
  cwd: '/path/to/project',
  node: '>=18 <23',
  packageManager: 'pnpm@^9',
})

console.log(result.node?.version, result.packageManager?.version)
console.log(result.warnings, result.trace)
```

Both inputs accept semver ranges, including `18`, `18.20`, exact versions, comparators and `||`. An omitted package manager defaults to npm. Conflicting or malformed declarations produce warnings and a trace of the retained conditions.

Files are collected from the real `cwd` through the nearest Git root, inclusive. A `.git` file is recognized for worktrees. Without a Git root, only `cwd` is read and a warning is returned. Directory proximity comes before source priority. Within each directory the order is:

1. `package.json#packageManager`
2. `pnpm-lock.yaml`, `shrinkwrap.yaml`, `yarn.lock`, `npm-shrinkwrap.json`, `package-lock.json`
3. `volta.node`, `.node-version`, `.nvmrc`, `.tool-versions` (`nodejs`)
4. `devEngines.runtime` (`name: node`), `devEngines.packageManager`
5. `engines.node`, then the selected manager's `engines` entry

Caller inputs precede every file. Equal-ranked occurrences retain their input order. A concrete value is a singleton constraint; it does not promote its source. A conflicting lower-priority condition and its derived Node requirement are ignored together. Package-manager versions retain their own `engines.node` requirements throughout resolution.

Node selection: retained exact version → current version if eligible → greatest eligible published version. Manager selection: retained exact version → selected Node's bound npm or local pnpm/Yarn if eligible → greatest eligible published version. No Node or npm version is hardcoded as a fallback.

## Version data

Each `infer()` fetches/revalidates eight official endpoints: the [Node release index](https://nodejs.org/dist/index.json), npm registry metadata for [npm](https://registry.npmjs.org/npm), [pnpm](https://registry.npmjs.org/pnpm), [historical Yarn](https://registry.npmjs.org/yarn), [Yarn cli-dist](https://registry.npmjs.org/@yarnpkg%2Fcli-dist), [Yarn CLI](https://registry.npmjs.org/@yarnpkg%2Fcli), [Yarn's official Berry tags](https://repo.yarnpkg.com/tags), and [Yarn release lines](https://repo.yarnpkg.com/releases). Yarn supports Classic (<2), Berry (>=2 <6) and native Yarn 6+ (`yarnpkg/zpm`). The native release list unions `releaseLines.zpm.tags`, `stable` and `canary`, then filters by SemVer stability, regardless of the channel label. Native releases carry `runtime: 'native'` and an unrestricted host Node constraint (`node: '*'`); this does not remove the project's Node declarations or the inference package's Node requirement. Older Yarn declarations prefer cli-dist, then yarn, then cli for duplicate versions. Tags absent from the registries trigger an additional package-manifest request at the official tag; absent engines stay unknown. Normal release lists omit prereleases. Explicit prerelease declarations trigger on-demand metadata queries. An exact version queries its official manifest or release entry; a range queries the relevant official version lists and retains only matching prereleases. Node ranges query the official dist, rc, nightly, v8-canary and test indexes. These records never enter the normal release statistics. Returned receipts include source URLs, fetch/check timestamps and response SHA-256.

The Node package cache holds metadata in this process only. Calls use ETag/Last-Modified revalidation, reuse 304 responses and share simultaneous requests. There is no default disk cache or bundled release list. A failed refresh may use earlier successful data with a timestamped warning. Without metadata, inference can use known runtime candidates and reports the limitation; it cannot assert a global maximum.

Only the compiled lockfile compatibility table is bundled. Confirmed behavior boundaries become semver intervals during maintenance. The last supported interval has no upper bound until a measured incompatibility establishes one. A format absent from this package version's table gives `*` while retaining the manager identity. This is a permissive inference policy, not proof that every project will install successfully.

Yarn lockfile identity includes its serialization family: native JSON (`features.yarnFamily: 'zpm'`) is distinct from Berry YAML even when both have `__metadata.version: 9`. Native formats without measured stable-version rules remain `*` and produce a warning. Existing open Berry ranges are not closed merely because Yarn changes implementation. Inference downloads metadata only, never package-manager executables.

The repository contains 23 compatibility fixtures: npm package-lock and shrinkwrap 1/2/3; pnpm legacy shrinkwrap 3/4 and lockfile 5/5.1/5.2/5.3/5.4/6/9; Yarn Classic v1 and Modern 4/5/6/7/8/9/10. A fixture passing at one version does not establish a complete range; unconfirmed formats remain `*`. See the retained matrix and boundary reports for measured coverage. The [initial data report](maintenance/evidence/initial-release-data/README.md) records the exact catalog, per-manager attempted/conclusive counts, unresolved cases and reproduction commands.

Run the complete initial matrix with `pnpm data:seed --concurrency 6`. The first run pins the official release catalog in `maintenance/evidence/initial-matrix/catalog.json`; every npm, pnpm and Yarn release, excluding prereleases and including historical stable Yarn distributions, is attempted against every fixture for that manager. Repeat the same command to resume. Use `--retry-incomplete` to retry environment/provisioning failures. Individual rows, logs, dependency bootstrap locks and `summary.json` are preserved; successful records are reused only when the tested inputs and experiment contract match. A new catalog uses a separate `--output` directory. npm package-lock and shrinkwrap are separate compatibility predicates.

Historical Yarn bundles are also inventoried from the official tags. Maintenance resolves each tag to a commit, downloads the standalone script at that immutable commit, and records its URL, size and computed SHA-512. This maintenance digest is not represented as a registry-published SRI. Native Yarn maintenance downloads the matching official `@yarnpkg/yarn-<platform>` npm artifact, checks manifest identity, platform, SRI and the executable’s reported version, and runs it directly. Its receipt retains the platform package, exact version, source URLs, SRI and binary SHA-256. Missing platform artifacts are incomplete checks, not lock incompatibility. Expanded catalogs preserve original snapshots; the compiler can reuse old observations only when artifact identity and fixture bytes still match. See [initial compilation and pair retesting](maintenance/compile-initial.md).

An [explicit Yarn 6 integration verification](maintenance/evidence/yarn6-integration/README.md) exercises the native executable, JSON lock collection, node_modules/PnP frozen installation and inference. Its RC records are outside compatibility matrices, compiled ranges, release statistics and known-bug rules.

The [current stable-only report](maintenance/evidence/stable-only/README.md) records the current 21 compiled rules, 2 uncompiled formats and 5 active bug families. Earlier all-release reports remain historical evidence.

## API and CLI

- `infer(options?)`: filesystem collection, runtime detection, metadata and resolution.
- `collect({cwd?, node?, packageManager?})`: read-only collection, no project code execution.
- `resolve({sources, runtime}, catalog, rules?)`: pure resolver, also exported from `node-toolchain-infer/resolve`.
- `detectRuntime()`: current Node, adjacent npm, optional local pnpm/Yarn.
- `fetchCatalog()`, `loadCatalog(path)`, `loadRules()`: official facts and explicit snapshots/rules.
- `createSource(key, value, options?)`, `SOURCE_DEFINITIONS`: construct inputs for simulation.

`infer` accepts explicit `runtime`, `catalog`, `rules`, `fetcher` and `signal` for deterministic tests or caller-managed metadata. A supplied `catalog` makes no additional network requests, including for prereleases admitted by explicit versions or ranges but absent from that snapshot. Filesystem scan results are not cached.

```sh
node-toolchain-infer --cwd . --node '18' --package-manager 'pnpm@^9' --json
node-toolchain-infer --help
```

The result includes the selected versions, warnings, ordered trace, retained constraints, candidate versions, scanned directories and metadata timestamp. The CLI exits nonzero for operational failures or when no runnable pair exists; declaration conflicts alone are warnings.

## Development

Use Node 24 and pnpm 10.33.0 for repository tooling; the published package runs on Node ≥18.

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm pack
pnpm website:build
pnpm website:serve
```

`website/` is a pure frontend with four independent tabs and a Chinese/English switch. Its fetch adapter uses `cache: no-cache` to let the browser revalidate its HTTP cache, without manually adding conditional headers that trigger CORS preflight. The application keeps version data in memory and does not write version snapshots to localStorage or IndexedDB; HTTP cache storage follows browser policy. It imports the same resolver and official metadata parser as the package. The server prints its local URL; set `PORT=49295` to choose that port. Browser checks use `pnpm exec playwright install chromium` then `pnpm website:test`; `CHROME_PATH` can select an installed Chrome executable.

`tsc` is **TypeScript 7.0.2**. `eslint-config-unicute` uses the official `@typescript/typescript6` compatibility API through Microsoft's [documented side-by-side aliases](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/). No dependency overrides are required. Formatting is performed by `pnpm lint:fix`.

Scheduled compatibility checks, fixture generation, retained evidence, failure exit codes and the AI maintenance procedure are documented in `maintenance/`. GitHub Actions preserves new maintenance evidence on the `compatibility-data` branch. Pushes to `main` build and deploy the bilingual website to GitHub Pages. Version tags publish the npm package through the `npm` Environment using trusted publishing; see [publishing](docs/publishing.md).

Frozen installation uses each pnpm release’s historical option: `--frozen-shrinkwrap` before `3.0.0-alpha.3`, then `--frozen-lockfile`. The option is selected by the tested manager version for both lockfile names. An ignored option cannot establish support because the contradictory-manifest control must also pass.
