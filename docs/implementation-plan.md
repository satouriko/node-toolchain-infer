# toolchain-infer Implementation Plan

> For agentic workers: use subagent-driven-development for bounded independent data and maintenance tasks; the controller implements the resolver and integration. Execute continuously under the user's existing authorization.

**Goal:** Deliver a usable standalone npm package plus automated data acquisition and AI-maintained frozen-install evidence.
**Architecture:** Pure version-pair resolver, filesystem collector, independent data refresh, isolated compatibility runner.
**Tech Stack:** Node >=20, JavaScript ESM, semver, yaml, node:test, TypeScript declarations.
**Spec:** docs/design.md

## Global Constraints

- Work only in /Users/cuteloli/Code/toolchain-infer; no edits to litest or the website.
- npm/pnpm/Yarn/Bun are supported. Bun does not imply absence of Node.
- Directory distance precedes source priority; version conflicts warn and ignore the lower-priority condition.
- No hardcoded fallback Node/npm. Preserve package manager / engines.node candidate relationships.
- Data provenance distinguishes upstream inference, official source, and fixture verification; unknown is not pass.
- All network writes, npm publish and remote hosting are outside this task. Local package and tarball are the deliverable.

## Task 1: Automatic data and update detection

Owner: data implementer. Files: src/catalog.js; scripts/sync-data.js, sync-upstream.js, check-releases.js, validate-data.js; test/catalog.test.js, upstream.test.js, releases.test.js; data/catalog.json, upstream.json. Do not edit package.json or compatibility.json.

- [ ] Write failing tests for parsing actual HTTP fixture shapes, rejecting malformed declared engines, and preserving destination on HTTP/parse failure.
- [ ] Implement `loadCatalog(path?)` and `fetchCatalog({fetcher=fetch, signal}={})`, returning the design schema. JSON endpoints: nodejs.org/dist/index.json; registry.npmjs.org/{npm,pnpm,yarn,@yarnpkg%2Fcli-dist,bun}. Merge Yarn Classic major=1 and Berry major>=2. Verify version key equals manifest.version; retain prereleases as records. Missing node is null.
- [ ] Export `fetchUpstream({fetcher=fetch}={})` and `loadRules({upstreamPath?,compatibilityPath?}={})`. loadRules returns an array of normalized rules, curated rules first. Extract the Renovate pnpm table and npm/Yarn branches from current source without executing source. Capture URL/hash/date; refuse unrecognized layouts rather than producing an empty or overly broad range.
- [ ] Implement CLI sync scripts writing atomically only after complete validation. `--output PATH` supported. Run against live sources to populate release data and upstream rules.
- [ ] Implement `check-releases.js`: compare catalog's released stable package manager versions against compatibility observations supplied through `--observations PATH`; filter `--manager` and output JSON via `--output PATH` including uncovered versions, fixture coverage requirements, prompt template path. This script never mutates existing verified rules. Summarize rather than printing all metadata.
- [ ] Implement validate-data checking schema, ranges, rule match types and receipt presence. Missing observations are allowed (reported uncovered), malformed observation data errors.
- [ ] Run focused tests, self-review, commit only owned files, report commands/results and provenance.

## Task 2: Collector, resolver and public API

Owner: controller. Files: src/sources.js, collect.js, runtime.js, resolve.js, index.js; bin/toolchain-infer.js; types/index.d.ts; test/resolve.test.js, collect.test.js, api.test.js.

- [ ] Write behavior tests from docs/design.md before implementations.
- [ ] Implement strictly ordered filesystem collection, protected ancestor boundary, all declared sources including Yarn cacheKey and Bun lock formats, warnings for unreadable/malformed files without executing project code.
- [ ] Implement pure pair-preserving priority merge and selection. Data/rules arguments allow deterministic tests; current runtime pair remains available as fallback even absent in snapshot. Retained conditional engines do not select a manager type.
- [ ] Add runtime detection bound to process.execPath; npm manifest first, Node index second, inspected command fallback last with warning. Local PM candidates optional; never execute arbitrary project scripts.
- [ ] Implement API and CLI flags --cwd, --root, --node, --package-manager, --catalog, --rules, --pretty. A CLI source override represents remoteContainer at cwd; invalid argument usage is CLI error, version conflicts remain warnings.
- [ ] Verify deterministic input permutations at different directory depths, explicit ranges, pinned managers incompatible with Node, no declaration fallback, missing manager version and Bun/Node coexistence.

## Task 3: AI compatibility maintenance and real fixtures

Owner: compatibility implementer after Task 1 review. Files: maintenance/**, fixtures/**, data/compatibility.json, test/maintenance.test.js. Do not edit core modules or package.json.

- [ ] Read the structured source catalogue at /Users/cuteloli/.codex/artifacts/node-toolchain-lab/lockfile-sources.json for verified provenance. Build curated official additions separately from automated Renovate rules.
- [ ] Define fixture manifest with manager, format/cacheKey/features, generator manager+Node, command, protected file paths, hashes, and real local dependency. Every supported format has a folder or explicit coverage entry with actionable pending status; never hand-edit only lockfileVersion to counterfeit a format.
- [ ] Write runner behavioral tests before implementation: clean install pass, successful command rewriting a lockfile fails, manifest rewrite fails, command failure vs environment error, timeout cleanup, target --version verification, clean copy per run.
- [ ] Implement verified local tool provisioning and fixture generation with explicit Node binary, then `run-matrix.js --manager NAME --version VERSION --node PATH --output PATH` runs every fixture for that manager with frozen commands. Store JSON plus logs and byte hashes. Fixtures remain immutable. Cache outside fixtures; no global installs.
- [ ] Generate and run actual npm, pnpm, Yarn and Bun fixtures. Prefer all known format generations with explicit valid producer versions and compatible runtimes. Record exact successes/failures; unavailable environments become pending coverage, not invented results.
- [ ] Create maintenance/update-compatibility.prompt.md and a reproducible method documenting release discovery, Node engine choice, upstream vs observed discrepancies, fixture creation, exception promotion with evidenceIds, and final validation commands. No automatic open-ended semver claims from one sample.
- [ ] Add explicit pending version jobs referencing prompt and fixture set. Baseline observations include at least four manager families with real executions.
- [ ] Run focused tests, self-review, commit owned files, report evidence and gaps.

## Task 4: Integration, review, package artifact

Owner: controller. Files: README.md, test/package.test.js, package.json only if needed for real integration.

- [ ] Document API/CLI examples, exact priority, data refresh commands, the two maintenance categories, fixture matrix method and current verified coverage.
- [ ] Run full unit suite, data validation, scan nested real temp project, exercise CLI and API using production data.
- [ ] Run npm pack and install tarball into a new temp consumer, verify exported API/CLI/data/types. Inspect included files for secrets, caches and fixture evidence claims.
- [ ] Request independent review, address material findings, rerun covering verification, report package path and test results.
