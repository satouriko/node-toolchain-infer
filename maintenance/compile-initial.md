# Compile an initial measured matrix

`compile-initial.ts` is an independent, read-only consumer of immutable seed rows and current fixture bytes. It never runs package managers, downloads metadata or modifies seed records. It writes a proposed bundled table and detailed reports only to an explicitly supplied output directory. Review that proposal before replacing the shipped compatibility table.

```sh
pnpm exec tsx maintenance/compile-initial.ts \
  --catalog maintenance/evidence/initial-matrix/catalog.json \
  --recipes fixtures/recipes.json \
  --fixtures-root fixtures \
  --evidence maintenance/evidence/initial-matrix \
  --output .cache/initial-compatibility-review
```

Repeat `--evidence` to read additional directories containing immutable `rows/*.json`. Each directory's original `catalog.json` is retained and loaded explicitly. When the selected catalog grows, an older observation remains usable only if its original snapshot is supplied and both catalogs identify the same version, artifact URL, integrity and bundle provenance. Adjacency is always computed from the complete selected catalog, including newly discovered intermediate stable versions. No old row or snapshot is rewritten. The pure `compileInitial({catalog, evidenceCatalogs?, fixtures, fixtureHashes, rows, knownBugs?, generatedAt?})` API accepts these inputs without filesystem access; `compileInitialPaths(paths)` hashes current fixture inputs and writes `compatibility.json`, `report.json` and `report.md`. Raw observations and unknown/null rules stay outside the bundled table. Only confirmed non-null ranges enter package data; omitted formats infer as `*`. The published table contains no provenance or evidence ID lists; maintenance reports retain every stable catalog version's observation IDs and row IDs, including unresolved attempts; archived prerelease records remain unchanged and do not enter the report.

## Evidence and boundary algorithm

1. Group by manager, exact lock filename, format and features. Different fixtures sharing that match must independently produce the same range; disagreement produces unknown rather than picking a convenient fixture. npm `package-lock.json` and `npm-shrinkwrap.json`, and pnpm `pnpm-lock.yaml` and `shrinkwrap.yaml`, remain distinct.
2. Check each record against the selected current fixture digest and catalog artifact integrity. Only SeedRow protocol `frozen-initial-matrix-v2` and Observation protocol `frozen-install-v2` qualify. Older records are retained as superseded history. `inputHashes` identifies the original fixture bytes; before/after hashes cover those inputs plus every name in `FROZEN_LOCKFILES`, including `<missing>` sentinels for absent files, so new alternative root locks are detected. Row and observation identities must agree; the actual tool version, runtime integrity, protocol, reproduction log path and prescribed frozen command must be present. A pass additionally requires successful exit, unchanged input bytes, semantic verification and correct installed dependency versions. Rewrite requires successful exit and changed bytes; semantic mismatch requires successful exit and incorrect installed dependencies. Those two outcomes, and a completed explicit incompatibility rejection, are negative raw results. A reviewed known-bug exception can separately establish semantic compatibility without changing the raw outcome. Missing, invalid and inconclusive observations stay unknown. The compiler consumes the runner's explicit rejection classification; it does not reinterpret command logs or verify downloaded tarballs again.
3. Preserve all attempts. Conclusive disagreement is unresolved even if a later attempt passed. An inconclusive retry does not erase a conclusive result. Once a valid conclusive result exists, other failed attempts remain informational history rather than unfinished work. Conflicting conclusive results remain unresolved. Records from different fixture bytes or catalog snapshots cannot prove the selected fixture's behavior.
4. Traverse the complete official stable release ordering, never major-version buckets. Opposite adjacent outcomes confirm a boundary only when at least one pair used the same fixture hash, protocol, Node version and integrity, runtime architecture, host architecture and platform. Gaps or incomparable environments produce explicit retest tasks. A later measured rejection cannot be hidden behind an unknown point while retaining an open range that admits it.
5. A confirmed unsupported-to-supported transition supplies an inclusive lower bound. A confirmed supported-to-unsupported transition supplies an exclusive upper bound; restored support creates an OR interval. There is no maximum-tested upper bound. A missing/inconclusive tail therefore leaves a proven interval open. A partially confirmed set whose intervals contradict any measured stable outcome is withheld. All-pass samples without a confirmed lower boundary remain unknown under the existing strict proof contract.
6. Only stable versions compile to semver intervals with stable comparator bounds. Prerelease releases and observations do not contribute points, counts, boundaries, retest tasks or ranges. Keep their original archived bytes unchanged. Runtime exact prerelease inputs, including exact `packageManager` declarations, are handled separately through on-demand metadata; automatic choices remain stable. Unknown formats retain null in the report and are omitted from package rules, interpreted by inference as `*`.

This extends the old boundary compiler to consume full matrix records and recognize rewrite/semantic mismatch as negative contract results. It deliberately retains the old same-Node proof requirement. Historical-Node seed observations can reveal candidate transitions without proving that the package-manager version alone caused them. No cross-Node result is silently promoted to a confirmed boundary.

Explicit installation environments must also match for paired boundaries and baseline/control comparisons. Preserve them in observation fingerprints and retest descriptions. A lockfile setting mismatch is not a format boundary when the runner failed to reproduce that fixture's configuration.

After compilation, run `pnpm data:audit --report OUTPUT/report.json --json OUTPUT/gaps.json --markdown OUTPUT/gaps.md`. It inventories every stable internal gap, uncompiled positive and range contradiction with exact row/evidence IDs. Review all entries before updating package data; do not equate an unknown test point with an excluded semver version. A null range means inference keeps `*`, when stable releases do not establish a complete restriction.

## Retest tasks and unresolved results

`report.retests` contains `fixtureId`, `beforeVersion`, `afterVersion`, reason, existing environments on both sides (Node, integrity, architecture, platform, protocol and observation ID), and up to three `nodeCandidates`. A gap yields the adjacent pairs needed to fill it. Candidates come only from the supplied official Node catalog and must satisfy both declared engines ranges; existing observed Nodes are preferred. If an engine is absent, the candidate list stays empty. These are engine-compatible candidates, not a claim that an old executable runs on that platform. Re-run both sides using one identical verified runtime and protocol.

The report distinguishes unmeasured versions, invalid evidence, inconclusive attempts, contradictory outcomes, unknown lower bounds, unknown formats, fixture disagreement, sparse transitions and incomparable environments. A null range remains unknown; the proposal never converts incomplete work into an incompatibility claim.

Run the generated adjacent-pair tasks in a separate evidence directory:

```sh
pnpm compat:retest \
  --report .cache/initial-compatibility-review/report.json \
  --catalog maintenance/evidence/initial-matrix/catalog.json \
  --output maintenance/evidence/initial-boundaries \
  --cache-dir .cache/maintenance --concurrency 2
```

Both sides use the same actual Node executable, version and architecture. The official distribution checksum and executable checksum are recorded separately. `--fixture` and `--version` select pairs; either endpoint selects the whole pair. `--node <exact>` selects an explicitly verified common runtime, and `--node-arch x64` enables historical macOS binaries through Rosetta. The chosen Node must exist in the selected catalog and satisfy both engines; there is no host fallback. `--retry-incomplete` appends attempts while reusing a conclusive side only in the same verified environment. Failed provisioning and bootstrap receipts are retained. `completePairs` means both sides have conclusive outcomes, which may include incompatibility; it does not mean both installations pass. Compile again with both evidence directories.

Exit codes are 0 for fully compilable evidence, 1 for completed evidence requiring maintenance, and 2 when missing/inconclusive/invalid evidence remains. All three output files are written before returning those statuses. Input filesystem/JSON errors cause the CLI to report the error and exit 2; they do not produce a misleading partial table. Use a separate review directory for output, never an evidence directory.

## Verification

Independent tests cover restored support, genuine rewrite/semantic failures, open future support, sparse and cross-Node transitions, prerelease exclusion with unchanged source evidence, conflicting retries, file-specific rules, nested features, forged/stale evidence, missing formats, all-pass unknown lower bounds, adjacent retest task generation, and the disk entry's output and input preservation. The tests use clearly synthetic receipts; they establish compiler behavior, not real package-manager compatibility.

An in-progress matrix yields a provisional proposal: a locally confirmed lower boundary may later prove to be restored support once older releases are measured. The path entry reads only the supplied seed-row directories; it does not silently import legacy `observations.json` or discovery receipts from other catalogs/protocols. Finish the intended matrix or provide explicitly normalized, reviewed baseline rows before treating the proposal as the complete history. The report's unmeasured/incomplete counts and nonzero exit status must accompany any review.

## Reviewed upstream bugs

`maintenance/known-bugs.json` separates raw experiment outcomes from semantic format compatibility. A released manager can understand (and even generate) a format while an installer bug fails the frozen test. Confirm compatibility independently from official reader/generator source or a controlled reproduction, and establish that the specific failure is caused by the known bug. A matching format number alone is not an automatic exemption.

Each review records bug ID, manager, affected semver range, fixture IDs, official issue/fix URL, reason, independent semantic evidence, review date, and the IDs plus fingerprints of reviewed observations. An exact match is classified as supported with an exception marker even if the raw status is rewrite, incompatible, semantic-mismatch or inconclusive. Normal evidence identity/protocol validation still applies. Unknown or unrelated failures never inherit a bug exception merely because their version lies in the affected range. A changed observation fingerprint is an error; original records are never relabeled. Log archive paths are excluded from the portable fingerprint, while actual commands, inputs, results and runtime identities remain bound.

The CLI reads `maintenance/known-bugs.json` by default; use `--known-bugs PATH` to select another review file. The pure API accepts `knownBugs`; the filesystem API accepts its path. Compilation reports retain original status, observation ID and bug ID; rule data includes only a compact bug marker. The resolver warns when an affected version is selected. The monitor applies the same reviewed decisions so resolved known bugs do not reopen the same maintenance finding. New unreviewed failures still require maintenance.
