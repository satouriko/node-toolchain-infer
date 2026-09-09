# npm compatibility gap audit

Audited 2026-09-09 against the exact report and shipped-data SHA-256 values in `coverage.json`. Every one of the 3,630 npm fixture/version points is classified. The six current fixtures cover package-lock and shrinkwrap formats 1, 2 and 3.

| Classification | Fixture/version points | Conclusion |
| --- | ---: | --- |
| Supported measurements | 1,171 | No failure to explain. |
| npm before 5.7.0 lacks `ci` | 1,632 | Preserve the required-command lower boundary. Some old CLIs print help and exit zero; the logs still show the full command list without `ci` and no installed dependency. |
| npm 5.7.0–6.14.18 cannot consume v3 | 170 | Preserve incompatibility: legacy lock-verify reads the absent `dependencies` map. |
| npm 7 beta unwanted saves, #1811 | 60 | Proven upstream bug; exact observation review candidate supplied. |
| npm 7 beta / 7.x / 8.0.0–8.4.0 missing validation, #4363 | 570 | Proven upstream bug; valid locks are read correctly, while the contradictory-manifest control exposes missing validation. |
| npm 12 shrinkwrap removal | 21 | Deliberate removal for all three formats; preserve the upper boundary. |
| npm 1.1.25 never executed | 6 | Invalid historical experiment, not format evidence; keep unknown. |

The 570 validation points have 576 current-protocol observations because the v3 boundary was repeated under historical runtimes. `candidate-known-bugs.json` contains 60 + 576 exact observation IDs and fingerprints. `review-audit.json` binds each one to original row bytes, log bytes, source bytes and semantic proof. Original measurements remain unchanged.

## Evidence and cause

**Unwanted saves:** npm's [fix commit](https://github.com/npm/cli/commit/24f3a5448) adds `save: false` to `arb.reify()`, and the [beta.12 release](https://github.com/npm/cli/releases/tag/v7.0.0-beta.12) links [issue #1811](https://github.com/npm/cli/issues/1811). Historical-Node reproductions of beta.0, beta.5, beta.6 and beta.11 match all 60 historical after-hash maps. All dependency locations, versions, resolved URLs and integrity values are preserved. beta.0–beta.5 also remove `private: true` from the manifest; formats 1 and 3 are rewritten as format 2. This is not merely whitespace, and the review explicitly describes the metadata write.

**Missing lock validation:** [PR #4363](https://github.com/npm/cli/pull/4363), fixing [#2701](https://github.com/npm/cli/issues/2701) and #3947, adds the missing comparison between lock and install inventories. The [8.4.1 release](https://github.com/npm/cli/releases/tag/v8.4.1) identifies the fix. Every reviewed primary install exits zero, installs locked `is-number@7.0.0`, and leaves all watched files unchanged. Its separately changed manifest instead installs 6.0.0, so the correct raw result remains inconclusive. It is the control enforcement that fails, not lock parsing.

`source-audit/index.json` covers all 105 official artifacts from 7.0.0-beta.0 through 8.4.0 plus 8.4.1. Their registry integrity was verified before extracting the 22 distinct `ci` sources. Every version loads the virtual lock; only 8.4.1 contains `validateLockfile`. `save: false` first appears at beta.12.

`reproductions/` has 48 fresh, historical-Node baseline runs across all six fixtures and eight npm versions, including both sides of each bug fix. `lock-selection-canary/` has 54 further frozen runs across all six format/filename pairs and nine npm versions. Its officially generated lock pins 6.0.0 under a manifest range accepting both 6 and 7: every frozen run chooses 6.0.0, while all nine lockless controls choose 7.0.0. This proves real lock consumption independently of nearby positive measurements or the original exact-version manifest.

**Real boundaries:** The [5.7.0 changelog](https://github.com/npm/cli/blob/v5.7.0/CHANGELOG.md) introduces `ci`. The [npm v8 format documentation](https://docs.npmjs.com/cli/v8/configuring-npm/package-lock-json/) explains the legacy compatibility data present in format 2 and absent in format 3. All 170 old v3 failures have the actual lock-verify stack frame. The [npm 12 changelog](https://github.com/npm/cli/blob/latest/CHANGELOG.md) explicitly removes loading `npm-shrinkwrap.json`; all 21 shrinkwrap failures reject the absent package-lock input. In total, 1,829 raw conclusive failure logs were checked rather than relying only on range endpoints.

**Invalid oldest experiment:** npm 1.1.25 has one attempt requesting a nonexistent Node 0.8 Darwin arm64 artifact, followed by two attempts where the bootstrapped modern `psl` dependency cannot parse under Node 0.8. No `ci` command executes. Fixing this measurement requires a runtime-compatible, receipt-pinned historical bootstrap dependency graph; simply retrying the same modern bootstrap is invalid. The current provisioner already selects x64 for pre-16 Darwin. This point is earlier than the independently proven introduction of `ci` and does not create a supported-range hole. No known-bug exception is proposed for it.

## Effect on the published ranges

- The four v1/v2 rules already admit the internal stable 7.0.0–8.4.0 unknown block. Registering #4363 supplies semantic evidence and a warning; it does not fill an existing stable exclusion.
- The npm 7 prerelease omissions are real raw failures explained by the two reviewed bugs. They should gain evidence-backed prerelease support, with bug annotations.
- Both v3 rules are currently absent because no lower boundary could be compiled across the unknown block. The reviewed measurements establish npm 7 support; the existing same-runtime 6.14.18/7.0.0 pair can establish the lower stable boundary.
- The many other `||` clauses add supported prerelease trains to a continuous stable range, as required by node-semver prerelease semantics. They are display supplements, not additional compatibility holes.
- npm 12 shrinkwrap removal and pre-npm-7 format-3 incompatibility must stay excluded.

No production code, shared known-bug registry, raw evidence row, or shipped compatibility data was edited by this audit. Root integration may merge the candidate reviews and recompile.

Scripts are archived as text under `scripts/` so the repository TypeScript build does not compile research artifacts. They were executed from `.cache/npm-gap-audit/` at the repository root using the installed tsx CLI and the existing `.cache/maintenance` artifact/runtime cache. Reproduction and canary scripts can be restored to that directory and rerun; the build-review script also uses the initial report's enumerated rows saved there during this audit. The durable review audit retains every selected raw row path and hash independently.
