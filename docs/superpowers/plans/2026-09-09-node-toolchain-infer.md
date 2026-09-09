# node-toolchain-infer Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent tasks; the controller implements the core and integration locally. Follow this approved plan continuously.

**Goal:** Deliver the standalone Node >=18 inference package, maintained compatibility data and a complete bilingual website in one project.
**Architecture:** Pure resolver and browser adapter; filesystem/runtime/official-data I/O; isolated fixture maintenance and Actions reporting; static multilingual website.
**Tech Stack:** Node >=18, TypeScript 7.0.2 (strict, ESM), pnpm 10.33.0, eslint-config-unicute, semver, yaml, node:test, generated TypeScript declarations, esbuild and Playwright for the website.
**Spec:** docs/design.md

## Global Constraints

- Root /Users/cuteloli/Code/node-toolchain-infer; never edit litest.
- Only npm, pnpm and Yarn; exact priority and data policy from spec are binding.
- No hardcoded Node/npm fallback, no Renovate mapping, no fabricated fixture observations.
- Independent website implementation may overlap controller core work but implementation subagents are sequential. No subagents spawned by implementers.
- No doc-only commits, no remote writes or publication. Preserve existing user files and the old site until new server is ready.

### Task 1: Bilingual website in the package repository

Files: website/** only. Source to migrate: /Users/cuteloli/.codex/artifacts/node-toolchain-lab (current approved site).

Interfaces: retain current site UI input/state/trace contract initially. Core integration is performed by controller using resolve({sources,runtime},catalog,rules); do not change root src or package.json.

- [ ] Copy production website assets, source, local serve/build scripts and tests; omit node_modules, .qa, unused third-party research and stale datasets. Use existing root semver dependency, or the copied vendor/semver.mjs for the site build; root esbuild supplied by controller.
- [ ] Add a browser test that switches Chinese/English, navigates each tab, preserves a calculator input and verifies the live fact filter. Run to observe missing language behavior.
- [ ] Implement complete Chinese/English content, including long rule and maintenance prose, dynamic calculator/trace/warning labels, ARIA attributes, date formatting, errors and toasts. Use explicit locale files; never runtime remote translation. Chinese/English static templates are allowed, but must share one behavior implementation and all IDs.
- [ ] Language controls are 中文 / English in header, preserve current tab/hash and entered values/filter, and persist preference. Both static and generated content must switch completely. Preserve four independent tabs and responsive layout. No slogan or local badge.
- [ ] Serve/build locally and inspect desktop and mobile in both languages. Use real official endpoints; do not ship test data as facts.
- [ ] Write website/README.md with bilingual build/serve instructions and validation results; report files and concerns. Do not commit shared files or start a persistent server on 49295 (controller will switch it).

### Task 2: Core, official metadata and public API

Files: src/**, bin/**, types/**, test/** (except maintenance tests), scripts/sync-data.ts, scripts/validate-data.ts, package.json, README*.md.

Interfaces: docs/design.md defines Source, runtime, catalog, rules and result. Export infer, collect, resolve, detectRuntime, fetchCatalog/loadCatalog/loadRules. Provide a browser-safe adapter src/playground.ts for the migrated calculator.

- [ ] Establish behavioral tests for direct input arbitrary ranges, current/maximum/bound npm selection, parent directory ordering, conditional engines and unknown lock *; run before correcting stale resolver behavior.
- [ ] Implement collector using JSON/yaml parsing and deterministic depth/rank/occurrence order. Test temporary nested Git directories, worktree .git file, same-directory lock sources, invalid manifests, no-Git start-only behavior and absence of project writes.
- [ ] Implement paired candidate resolver and structured trace/warnings. Remove Bun and remoteContainer restrictions. Ensure evidence ranges are used exactly as shipped.
- [ ] Test metadata through a local HTTP fixture server: conditional 304, deduplication, retry after failure, explicit stale fallback, missing engines and atomic sync output. Implement five official sources and per-process validation cache; no default snapshot.
- [ ] Detect process Node/bound npm and local pnpm/Yarn, expose API and CLI with cwd/node/package-manager, JSON output and readable help. Write API/CLI and npm binding tests.
- [ ] Implement generated TypeScript declarations and browser adapter; validate same input selects the same result through website and package core.

### Task 3: Compatibility maintenance, fixtures and GitHub Actions

Files: maintenance/**, fixtures/**, .github/**, scripts/check-releases.ts, data/compatibility.json, test/maintenance*.test.ts. Core/catalog APIs consumed per spec; root package.json owned by controller.

- [ ] Add failing behavior tests for preserved history, pass/rewrite/inconclusive frozen outcomes, semantic mismatch detection, new format detection, unresolved items, and range generation with open upper bounds and restored OR support.
- [ ] Implement official tarball integrity provisioning, exact compatible Node selection, fixture generation and matrix execution in clean temporary directories. No global installs. Persist reproducible record keys/logs and distinguish frozen rejection from network/environment failures.
- [ ] Generate actual npm, pnpm, Yarn Classic and Modern fixtures and run frozen installs. Add format-family directories with honest coverage metadata. Use only confirmed boundaries in generated compatibility.json; unknown formats remain *; list uncovered cases in maintenance docs.
- [ ] Implement maintenance check orchestration for new releases and unresolved issues, JSON/Markdown report, exit 0/1/2, and commands reusable by AI. Successful check records can be appended; only confirmed evidence updates compatibility ranges.
- [ ] Add scheduled/manual GitHub workflow: source fixtures and code from main, reuse/persist evidence on data branch, upload report/logs before failing; no automatic npm publish. Separate checks CI for Node18 and current LTS.
- [ ] Write complete English/Chinese AI maintenance prompts/method: release comparison, fixture creation, source verification, boundary confirmation, range compilation, same-command recheck. Test the real scripts and report baseline evidence without overstating coverage.

### Task 4: Integrate, review, pack and switch local site

Files: package.json/pnpm-lock.yaml, docs/**, README*.md, test/package.test.ts, website adapter integration.

- [ ] Integrate browser calculator with pure core/rules, build website, run all tests and Node18 tests.
- [ ] npm pack and install resulting tarball in a fresh temporary consumer; exercise API, CLI and TypeScript types. Include only runtime files and compiled compatibility rules in published package.
- [ ] Review full changes independently and resolve material issues. Save actual test evidence and limitations.
- [ ] Restart only the known old local website server so 127.0.0.1:49295 serves website/ in this project. Verify both locales, language persistence, tabs, deep links, calculator and official facts.
- [ ] Deliver repository path, tarball, local website and validation summary. No remote publish or push.

### Task 5: Establish the full initial release matrix (explicit user extension)

- [ ] Pin a fresh official catalog containing every published npm, pnpm, Yarn Classic 0.x/1.x and Modern release, including prereleases.
- [ ] Implement a bounded concurrent, resumable initial runner. Attempt every release against every fixture belonging to that manager; preserve each observation and command log immediately. Provisioning failures produce explicit incomplete records for the affected combinations and do not stop unrelated releases.
- [ ] Use verified historical Node binaries when old tools fail on the current runtime. Cache verified downloads; never interpret a missing executable, transport failure or unsupported host as lock incompatibility.
- [ ] Run the full matrix, inspect failures and missing formats, extend real generated fixture coverage, and retry only new/incomplete combinations. Confirm behavioral boundaries using comparable adjacent published releases before compiling bundled ranges.
- [ ] Publish local coverage/report artifacts listing attempted, passing, incompatible and incomplete combinations. Preserve all evidence in the repository, with a documented resume command. Update the website and documentation to reflect the measured initial table.
