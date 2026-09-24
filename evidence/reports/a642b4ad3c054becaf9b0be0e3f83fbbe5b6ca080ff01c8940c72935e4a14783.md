# Compatibility release check

Generated: 2026-09-24T05:25:27.061Z

Exit code: 2 (0 complete, 1 maintenance required, 2 incomplete)

- npm: 527/529 stable releases have conclusive observations for every recipe.
- pnpm: 833/987 stable releases have conclusive observations for every recipe.
- yarn: 169/199 stable releases have conclusive observations for every recipe.

## unknownFormats

None.

## mismatches

- pnpm@9.0.5 pnpm-lock-v6: rewrite, expected true (rule); logs/a4973009e91019d8d4d63d69b8556496052f3952e60779505da4cec17b4b55fc-5cc4b3129705.log

## unresolved

- pnpm@9.0.5 pnpm-lock-v6: rewrite, expected true (rule); logs/a4973009e91019d8d4d63d69b8556496052f3952e60779505da4cec17b4b55fc-5cc4b3129705.log
- pnpm@9.0.5:38110ce2f432ab70851c19999068683384a7b027599811045a942561522d1ded: conflicting initial observations 9c40d45d4229bd8799ed6bc1110f197c7528230b8629ce80855975e8164b96c4-0ee3e36b4b7b, 8d5c16aef125e237cbc468b764bd0b1099338dd7cec6d4577a5e66d76b8c7fdb-b91290686213, a4973009e91019d8d4d63d69b8556496052f3952e60779505da4cec17b4b55fc-5cc4b3129705

## incomplete

- 434 unprocessed release combinations remain; increase --max-releases or rerun with this state directory.
- pnpm@7.30.0: Error: Generation failed (1); maintenance/results/generated/b309de8bee8b301e087f2a4634dd187b93f56ad132c6c335947d38c4e9567598/generation.log: Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +1
+
 ERR_INVALID_THIS  Value of "this" must be of type URLSearchParams

pnpm [ERR_INVALID_THIS]: Value of "this" must be of type URLSearchParams
    at Proxy.getAll (node:internal/url:599:13)
    at Proxy.<anonymous> (/tmp/toolchain-generate-GHXJup/tools/pnpm-7.30.0/node_modules/pnpm/dist/pnpm.cjs:60458:55)
    at /tmp/toolchain-generate-GHXJup/tools/pnpm-7.30.0/node_modules/pnpm/dist/pnpm.cjs:60520:31
    at Array.reduce (<anonymous>)
    at Proxy.raw (/tmp/toolchain-generate-GHXJup/tools/pnpm-7.30.0/node_modules/pnpm/dist/pnpm.cjs:60519:33)
    at new Headers (/tmp/toolchain-generate-GHXJup/tools/pnpm-7.30.0/node_modules/pnpm/dist/pnpm.cjs:60404:28)
    at getNodeRequestOptions (/tmp/toolchain-generate-GHXJup/tools/pnpm-7.30.0/node_modules/pnpm/dist/pnpm.cjs:60753:23)
    at /tmp/toolchain-generate-GHXJup/tools/pnpm-7.30.0/node_modules/pnpm/dist/pnpm.cjs:60810:25
    at new Promise (<anonymous>)
    at fetch (/tmp/toolchain-generate-GHXJup/tools/pnpm-7.30.0/node_modules/pnpm/dist/pnpm.cjs:60808:14)
; logs/failure-39b83bbb-0f2e-4622-bcb0-c339137e2468.log
- pnpm@7.29.3: Error: Generation failed (1); maintenance/results/generated/6dbeeb337239938cdb79af99bad5a2f5e5f29b50b40c58a5ff0c0655e51bb2c7/generation.log: Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +1
+
 ERR_INVALID_THIS  Value of "this" must be of type URLSearchParams

pnpm [ERR_INVALID_THIS]: Value of "this" must be of type URLSearchParams
    at Proxy.getAll (node:internal/url:599:13)
    at Proxy.<anonymous> (/tmp/toolchain-generate-a9vpI6/tools/pnpm-7.29.3/node_modules/pnpm/dist/pnpm.cjs:59646:55)
    at /tmp/toolchain-generate-a9vpI6/tools/pnpm-7.29.3/node_modules/pnpm/dist/pnpm.cjs:59708:31
    at Array.reduce (<anonymous>)
    at Proxy.raw (/tmp/toolchain-generate-a9vpI6/tools/pnpm-7.29.3/node_modules/pnpm/dist/pnpm.cjs:59707:33)
    at new Headers (/tmp/toolchain-generate-a9vpI6/tools/pnpm-7.29.3/node_modules/pnpm/dist/pnpm.cjs:59592:28)
    at getNodeRequestOptions (/tmp/toolchain-generate-a9vpI6/tools/pnpm-7.29.3/node_modules/pnpm/dist/pnpm.cjs:59941:23)
    at /tmp/toolchain-generate-a9vpI6/tools/pnpm-7.29.3/node_modules/pnpm/dist/pnpm.cjs:59998:25
    at new Promise (<anonymous>)
    at fetch (/tmp/toolchain-generate-a9vpI6/tools/pnpm-7.29.3/node_modules/pnpm/dist/pnpm.cjs:59996:14)
; logs/failure-14bdd347-8bdf-4ed5-8453-6f713f3933f4.log
- pnpm@7.29.2: Error: Generation failed (1); maintenance/results/generated/b218977a5df9b49a9d2c1e19f69cb999028b422fc2314e3e0d1e69f0c5fb057f/generation.log: Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +1
+
 ERR_INVALID_THIS  Value of "this" must be of type URLSearchParams

pnpm [ERR_INVALID_THIS]: Value of "this" must be of type URLSearchParams
    at Proxy.getAll (node:internal/url:599:13)
    at Proxy.<anonymous> (/tmp/toolchain-generate-pYznfS/tools/pnpm-7.29.2/node_modules/pnpm/dist/pnpm.cjs:59646:55)
    at /tmp/toolchain-generate-pYznfS/tools/pnpm-7.29.2/node_modules/pnpm/dist/pnpm.cjs:59708:31
    at Array.reduce (<anonymous>)
    at Proxy.raw (/tmp/toolchain-generate-pYznfS/tools/pnpm-7.29.2/node_modules/pnpm/dist/pnpm.cjs:59707:33)
    at new Headers (/tmp/toolchain-generate-pYznfS/tools/pnpm-7.29.2/node_modules/pnpm/dist/pnpm.cjs:59592:28)
    at getNodeRequestOptions (/tmp/toolchain-generate-pYznfS/tools/pnpm-7.29.2/node_modules/pnpm/dist/pnpm.cjs:59941:23)
    at /tmp/toolchain-generate-pYznfS/tools/pnpm-7.29.2/node_modules/pnpm/dist/pnpm.cjs:59998:25
    at new Promise (<anonymous>)
    at fetch (/tmp/toolchain-generate-pYznfS/tools/pnpm-7.29.2/node_modules/pnpm/dist/pnpm.cjs:59996:14)
; logs/failure-fd0d8791-648f-47fc-a11d-1c95c7fdbc3b.log
- pnpm@7.29.1: Error: Generation failed (1); maintenance/results/generated/a3adff8dd4986b9b25e4b550bdfd0960d275acecac21fcf7110b907fbfdb6751/generation.log: Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +1
+
 ERR_INVALID_THIS  Value of "this" must be of type URLSearchParams

pnpm [ERR_INVALID_THIS]: Value of "this" must be of type URLSearchParams
    at Proxy.getAll (node:internal/url:599:13)
    at Proxy.<anonymous> (/tmp/toolchain-generate-i66OVE/tools/pnpm-7.29.1/node_modules/pnpm/dist/pnpm.cjs:59369:55)
    at /tmp/toolchain-generate-i66OVE/tools/pnpm-7.29.1/node_modules/pnpm/dist/pnpm.cjs:59431:31
    at Array.reduce (<anonymous>)
    at Proxy.raw (/tmp/toolchain-generate-i66OVE/tools/pnpm-7.29.1/node_modules/pnpm/dist/pnpm.cjs:59430:33)
    at new Headers (/tmp/toolchain-generate-i66OVE/tools/pnpm-7.29.1/node_modules/pnpm/dist/pnpm.cjs:59315:28)
    at getNodeRequestOptions (/tmp/toolchain-generate-i66OVE/tools/pnpm-7.29.1/node_modules/pnpm/dist/pnpm.cjs:59664:23)
    at /tmp/toolchain-generate-i66OVE/tools/pnpm-7.29.1/node_modules/pnpm/dist/pnpm.cjs:59721:25
    at new Promise (<anonymous>)
    at fetch (/tmp/toolchain-generate-i66OVE/tools/pnpm-7.29.1/node_modules/pnpm/dist/pnpm.cjs:59719:14)
; logs/failure-bbe813d6-eae5-48ce-9864-29984c883ea1.log
- pnpm@7.29.0: Error: Generation failed (1); maintenance/results/generated/16d0c761292d835abbe3c20224e249e2c787bec17f6a63c8ce044f5c68b28029/generation.log: Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +1
+
 ERR_INVALID_THIS  Value of "this" must be of type URLSearchParams

pnpm [ERR_INVALID_THIS]: Value of "this" must be of type URLSearchParams
    at Proxy.getAll (node:internal/url:599:13)
    at Proxy.<anonymous> (/tmp/toolchain-generate-uoXuor/tools/pnpm-7.29.0/node_modules/pnpm/dist/pnpm.cjs:59369:55)
    at /tmp/toolchain-generate-uoXuor/tools/pnpm-7.29.0/node_modules/pnpm/dist/pnpm.cjs:59431:31
    at Array.reduce (<anonymous>)
    at Proxy.raw (/tmp/toolchain-generate-uoXuor/tools/pnpm-7.29.0/node_modules/pnpm/dist/pnpm.cjs:59430:33)
    at new Headers (/tmp/toolchain-generate-uoXuor/tools/pnpm-7.29.0/node_modules/pnpm/dist/pnpm.cjs:59315:28)
    at getNodeRequestOptions (/tmp/toolchain-generate-uoXuor/tools/pnpm-7.29.0/node_modules/pnpm/dist/pnpm.cjs:59664:23)
    at /tmp/toolchain-generate-uoXuor/tools/pnpm-7.29.0/node_modules/pnpm/dist/pnpm.cjs:59721:25
    at new Promise (<anonymous>)
    at fetch (/tmp/toolchain-generate-uoXuor/tools/pnpm-7.29.0/node_modules/pnpm/dist/pnpm.cjs:59719:14)
; logs/failure-3826c76f-670c-4e85-aadc-a9f666707f7f.log
- yarn@4.9.1: Error: Actual tool version mismatch: 4.9.1-git.20250411.hash-1908ee79f

; logs/failure-a3ada717-bf42-4449-9c77-86d5633a2858.log
- pnpm@5.9.1: Error: Command failed: /opt/hostedtoolcache/node/24.21.0/x64/bin/node /tmp/toolchain-releases-NMkeiE/tools/pnpm-5.9.1/node_modules/pnpm/bin/pnpm.js --version
node:internal/modules/cjs/loader:1564
  const err = new Error(message);
              ^

Error: Cannot find module '@pnpm/cli-meta'
Require stack:
- /tmp/toolchain-releases-NMkeiE/tools/pnpm-5.9.1/node_modules/pnpm/lib/bin/pnpm.js
- /tmp/toolchain-releases-NMkeiE/tools/pnpm-5.9.1/node_modules/pnpm/bin/pnpm.js
    at Module._resolveFilename (node:internal/modules/cjs/loader:1564:15)
    at wrapResolveFilename (node:internal/modules/cjs/loader:1118:27)
    at defaultResolveImplForCJSLoading (node:internal/modules/cjs/loader:1142:10)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1169:12)
    at Module._load (node:internal/modules/cjs/loader:1341:5)
    at wrapModuleLoad (node:internal/modules/cjs/loader:261:19)
    at Module.require (node:internal/modules/cjs/loader:1674:12)
    at require (node:internal/modules/helpers:157:16)
    at /tmp/toolchain-releases-NMkeiE/tools/pnpm-5.9.1/node_modules/pnpm/lib/bin/pnpm.js:29:82
    at async /tmp/toolchain-releases-NMkeiE/tools/pnpm-5.9.1/node_modules/pnpm/lib/bin/pnpm.js:29:34 {
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    '/tmp/toolchain-releases-NMkeiE/tools/pnpm-5.9.1/node_modules/pnpm/lib/bin/pnpm.js',
    '/tmp/toolchain-releases-NMkeiE/tools/pnpm-5.9.1/node_modules/pnpm/bin/pnpm.js'
  ]
}

Node.js v24.21.0
; logs/failure-6f16ad55-53a0-499f-9a1b-16748e878fb2.log

## Incremental check

8 releases checked this run; 1715 exact artifacts have recorded results.
Previous failures are retained in [history.md](history.md) and history.json; they are not rerun or relabeled as compatible.

Reproduce with the catalog.json, observations.json, state.json and logs in this artifact; see maintenance/update-compatibility.prompt.md. Historical point observations do not establish compatibility boundaries.
