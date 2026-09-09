# Final initial-data incremental audit

Date: 2026-09-09

Verdict: **PASS. The complete attempt coverage and final incremental data are internally consistent; no actionable discrepancy found.** This closes the pending-tail qualification of `task-3-initial-data-snapshot-review.md`. It does not turn unknown outcomes into support or claim that every installation succeeded.

Reviewed `maintenance/evidence/initial-release-data/{compatibility.json,report.json,coverage.json,README.md}`. Final compatibility SHA-256: `7b59efec3979e4227e090de05b17dc251d30a063e965ba24936c562981138a7a`; report SHA-256: `09d26de1350e517ca105185017c39bfe499ee156431c1aa925d831e15ed69755`.

## Recomputed coverage

All fixture-level outcome counts, manager totals, attempted counts from nonempty point row IDs, and catalog counts agree with `coverage.json`:

| Measure | Recomputed count |
| --- | ---: |
| Exact releases, including prereleases | 2,259 |
| Fixtures | 23 |
| Combinations / attempted | 18,181 / 18,181 |
| Supported | 4,769 |
| Unsupported | 11,136 |
| Conclusive | 15,905 |
| Unknown | 2,276 |
| Unattempted | 0 |

The catalog semantic/file hashes, 19 compiled rules, four unknown fixture names, 174 unresolved retest pairs, and 49 reviewed exclusions also agree with the underlying data. README explicitly says an attempt may fail before the installer executes, and conclusive results include incompatibility. It does not equate attempted coverage with successful installations.

## Incremental rules and evidence

Compared with the previously audited snapshot, only pnpm formats 5, 5.1, 5.2, 5.3 and 5.4 gained clauses: seven exact historical `0.0.0-*` prerelease versions for each format, 35 new fixture/version clauses altogether. No clauses were removed and stable intervals did not change.

All 35 additions correspond to supported prerelease points in the current report. For each, an actual preserved pass row was located, accepted by the current monitor/command/control validator, and its baseline/control log outcomes checked. All 35 passed. The final data passes the public compatibility-data validator. All 10,382 conclusive stable points covered by the 19 ranges agree with range membership; none contradicts an emitted rule.

Four ranges remain unknown and permissive `*`: `npm-package-lock-v3`, `npm-shrinkwrap-v3`, `yarn-classic-v1`, and `yarn-modern-v7`. The compiler's exit 2 and 174 unresolved npm v3 pair tasks are retained despite every catalog combination having an attempt. Prior boundary identity/adjacency checks remain applicable because stable intervals were unchanged.

The read-only incremental audit script is retained at `/tmp/final-data-increment-audit.mts` and reported no issues.

## Store isolation scope

The runner's three added environment aliases (`npm_config_store`, `npm_config_store_path`, `pnpm_store_path`) all point to the project's temporary `.pnpm-store`, alongside the existing modern key. All six official source-receipt archives independently matched their SRI and captured source-file bytes. Those sources and production-execute probe reports in `maintenance/evidence/pnpm-store-isolation` support the historical key selection and local store paths. The probe reports explicitly record production execution without environment overrides. This change concerns cache location, with no frozen-command or fixture-input change; store probes are not treated as compatibility evidence.

No production, fixture, or evidence files were modified in this review. No install, provisioning, matrix, or broad test run was started; verification used saved bytes, records, logs, and read-only audit scripts.
