# Compatibility release check

Generated: 2026-09-10T08:14:09.576Z

Exit code: 2 (0 complete, 1 maintenance required, 2 incomplete)

- npm: 526/527 stable releases have conclusive observations for every recipe.
- pnpm: 825/980 stable releases have conclusive observations for every recipe.
- yarn: 169/199 stable releases have conclusive observations for every recipe.

## unknownFormats

None.

## mismatches

None.

## unresolved

None.

## incomplete

- 178 unprocessed release combinations remain; increase --max-releases or rerun with this state directory.
- yarn@4.9.1: Error: Actual tool version mismatch: 4.9.1-git.20250411.hash-1908ee79f

- pnpm@5.9.1: Error: Command failed: /opt/hostedtoolcache/node/24.20.0/x64/bin/node /tmp/toolchain-releases-nQC3nN/tools/pnpm-5.9.1/node_modules/pnpm/bin/pnpm.js --version
node:internal/modules/cjs/loader:1564
  const err = new Error(message);
              ^

Error: Cannot find module '@pnpm/cli-meta'
Require stack:
- /tmp/toolchain-releases-nQC3nN/tools/pnpm-5.9.1/node_modules/pnpm/lib/bin/pnpm.js
- /tmp/toolchain-releases-nQC3nN/tools/pnpm-5.9.1/node_modules/pnpm/bin/pnpm.js
    at Module._resolveFilename (node:internal/modules/cjs/loader:1564:15)
    at wrapResolveFilename (node:internal/modules/cjs/loader:1118:27)
    at defaultResolveImplForCJSLoading (node:internal/modules/cjs/loader:1142:10)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1169:12)
    at Module._load (node:internal/modules/cjs/loader:1341:5)
    at wrapModuleLoad (node:internal/modules/cjs/loader:261:19)
    at Module.require (node:internal/modules/cjs/loader:1674:12)
    at require (node:internal/modules/helpers:157:16)
    at /tmp/toolchain-releases-nQC3nN/tools/pnpm-5.9.1/node_modules/pnpm/lib/bin/pnpm.js:29:82
    at async /tmp/toolchain-releases-nQC3nN/tools/pnpm-5.9.1/node_modules/pnpm/lib/bin/pnpm.js:29:34 {
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    '/tmp/toolchain-releases-nQC3nN/tools/pnpm-5.9.1/node_modules/pnpm/lib/bin/pnpm.js',
    '/tmp/toolchain-releases-nQC3nN/tools/pnpm-5.9.1/node_modules/pnpm/bin/pnpm.js'
  ]
}

Node.js v24.20.0

- pnpm@5.4.1: Error: Generation failed (1); maintenance/results/generated/7ae5e1fa3f77dbf6b08ea9c7c4f506d528affb5632baf693b377c4ebb6bdfa85/generation.log: Error: Cannot find module 'delay'
Require stack:
- /tmp/toolchain-generate-4atIkV/tools/pnpm-5.4.1/node_modules/pnpm/lib/node_modules/@pnpm/store-connection-manager/lib/index.js
- /tmp/toolchain-generate-4atIkV/tools/pnpm-5.4.1/node_modules/pnpm/lib/node_modules/@pnpm/plugin-commands-import/lib/import.js
- /tmp/toolchain-generate-4atIkV/tools/pnpm-5.4.1/node_modules/pnpm/lib/node_modules/@pnpm/plugin-commands-import/lib/index.js
- /tmp/toolchain-generate-4atIkV/tools/pnpm-5.4.1/node_modules/pnpm/lib/cmd/index.js
- /tmp/toolchain-generate-4atIkV/tools/pnpm-5.4.1/node_modules/pnpm/lib/main.js
- /tmp/toolchain-generate-4atIkV/tools/pnpm-5.4.1/node_modules/pnpm/lib/bin/pnpm.js
- /tmp/toolchain-generate-4atIkV/tools/pnpm-5.4.1/node_modules/pnpm/bin/pnpm.js
    at Module._resolveFilename (node:internal/modules/cjs/loader:1564:15)
    at wrapResolveFilename (node:internal/modules/cjs/loader:1118:27)
    at defaultResolveImplForCJSLoading (node:internal/modules/cjs/loader:1142:10)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1169:12)
    at Module._load (node:internal/modules/cjs/loader:1341:5)
    at wrapModuleLoad (node:internal/modules/cjs/loader:261:19)
    at Module.require (node:internal/modules/cjs/loader:1674:12)
    at require (node:internal/modules/helpers:157:16)
    at Object.<anonymous> (/tmp/toolchain-generate-4atIkV/tools/pnpm-5.4.1/node_modules/pnpm/lib/node_modules/@pnpm/store-connection-manager/lib/index.js:9:17)
    at Module._compile (node:internal/modules/cjs/loader:1929:14) {
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    '/tmp/toolchain-generate-4atIkV/tools/pnpm-5.4.1/node_modules/pnpm/lib/node_modules/@pnpm/store-connection-manager/lib/index.js',
    '/tmp/toolchain-generate-4atIkV/tools/pnpm-5.4.1/node_modules/pnpm/lib/node_modules/@pnpm/plugin-commands-import/lib/import.js',
    '/tmp/toolchain-generate-4atIkV/tools/pnpm-5.4.1/node_modules/pnpm/lib/node_modules/@pnpm/plugin-commands-import/lib/index.js',
    '/tmp/toolchain-generate-4atIkV/tools/pnpm-5.4.1/node_modules/pnpm/lib/cmd/index.js',
    '/tmp/toolchain-generate-4atIkV/tools/pnpm-5.4.1/node_modules/pnpm/lib/main.js',
    '/tmp/toolchain-generate-4atIkV/tools/pnpm-5.4.1/node_modules/pnpm/lib/bin/pnpm.js',
    '/tmp/toolchain-generate-4atIkV/tools/pnpm-5.4.1/node_modules/pnpm/bin/pnpm.js'
  ]
}

- pnpm@4.12.3: Error: Command failed: /opt/hostedtoolcache/node/24.20.0/x64/bin/node /tmp/toolchain-releases-nQC3nN/tools/pnpm-4.12.3/node_modules/pnpm/bin/pnpm.js --version
node:internal/modules/cjs/loader:1564
  const err = new Error(message);
              ^

Error: Cannot find module '@pnpm/cli-utils'
Require stack:
- /tmp/toolchain-releases-nQC3nN/tools/pnpm-4.12.3/node_modules/pnpm/lib/bin/pnpm.js
- /tmp/toolchain-releases-nQC3nN/tools/pnpm-4.12.3/node_modules/pnpm/bin/pnpm.js
    at Module._resolveFilename (node:internal/modules/cjs/loader:1564:15)
    at wrapResolveFilename (node:internal/modules/cjs/loader:1118:27)
    at defaultResolveImplForCJSLoading (node:internal/modules/cjs/loader:1142:10)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1169:12)
    at Module._load (node:internal/modules/cjs/loader:1341:5)
    at wrapModuleLoad (node:internal/modules/cjs/loader:261:19)
    at Module.require (node:internal/modules/cjs/loader:1674:12)
    at require (node:internal/modules/helpers:157:16)
    at /tmp/toolchain-releases-nQC3nN/tools/pnpm-4.12.3/node_modules/pnpm/lib/bin/pnpm.js:10:61
    at async /tmp/toolchain-releases-nQC3nN/tools/pnpm-4.12.3/node_modules/pnpm/lib/bin/pnpm.js:10:26 {
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    '/tmp/toolchain-releases-nQC3nN/tools/pnpm-4.12.3/node_modules/pnpm/lib/bin/pnpm.js',
    '/tmp/toolchain-releases-nQC3nN/tools/pnpm-4.12.3/node_modules/pnpm/bin/pnpm.js'
  ]
}

Node.js v24.20.0

- pnpm@4.2.1: Error: Generation failed (1); maintenance/results/generated/09fec0584941ab760b151b8b9171fbdfe7b198197c4cdcf3142c26df7544490c/generation.log: 
- pnpm@4.2.0: Error: Generation failed (1); maintenance/results/generated/3b2b491c28e2117bb8e2e3d5204f950ca3bbf121eeb1d3b53d4ac850c6473614/generation.log: 
- pnpm@3.7.2: Error: Generation failed (1); maintenance/results/generated/a1cfc72676c1aa5c4e058f7ef041ced53f63952fb7be5306e20b1a1913003bf3/generation.log: 
- pnpm@3.5.4: Error: Download HTTP 404: https://registry.npmjs.org/pnpm/-/pnpm-3.5.4.tgz

Reproduce with the catalog.json, observations.json, state.json and logs in this artifact; see maintenance/update-compatibility.prompt.md. Historical point observations do not establish compatibility boundaries.
