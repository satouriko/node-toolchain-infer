# Yarn 6 native adapter verification

This directory verifies an explicitly selected `yarn@6.0.0-rc.20` on macOS arm64 with project Node `18.20.8`. These prerelease checks are outside active fixture recipes, compatibility matrices, compiled ranges, release statistics and knownBugs. They do not establish a stable Yarn compatibility interval. The existing 21 compiled rules remain unchanged.

The official [release-line feed](https://repo.yarnpkg.com/releases) supplied the exact version. `catalog.json` retains that query and its response digest. `artifact.json` records the official `@yarnpkg/yarn-aarch64-apple-darwin` metadata URL, tarball URL, registry SRI and verified executable SHA-256. The extracted executable reported `6.0.0-rc.20`; it was run directly, with no Node wrapper or Berry bootstrap. Only macOS arm64 was exercised by this integration check.

| Project linker | Frozen install | Input and lock bytes | Installed dependency | Contradictory manifest |
| --- | --- | --- | --- | --- |
| node_modules | Passed | Unchanged | is-number@7.0.0 | Rejected |
| PnP | Passed | Unchanged | is-number@7.0.0, resolved by Node 18 | Rejected |

Each directory contains the real generated package manifest, Yarn configuration and JSON lockfile, plus generation output and the inference result. `verification.json` contains frozen-install receipts, exact command arguments, before/after hashes, dependency checks and nested contradictory-manifest controls. Full output is in `logs/`. Yarn generated JSON metadata version 9; collection marked it `features.yarnFamily: zpm`, and inference did not reuse Berry YAML version 9 rules. The explicit Yarn RC and current Node were retained with an unknown-lock-compatibility warning.

To reproduce, call `provisionNativeYarn('6.0.0-rc.20', temporaryToolsDirectory)` from `maintenance/provision.ts`. It verifies the current host's official platform artifact and returns the executable and receipt. Copy one of this directory's three input files (`package.json`, `.yarnrc.yml`, `yarn.lock`) into a fresh project outside another Yarn project, then run that executable with `install --immutable`, scripts disabled, the intended Node directory first on PATH and isolated Yarn cache/global directories. Compare all input hashes and verify the installed package version. Repeat with only the manifest dependency changed to `is-number@6.0.0`; the unchanged lock must be rejected. `runFixture` implements these checks and records both receipts. No global installation is involved.

The first stable native release must be measured against all existing Yarn fixtures and its own generated native fixture. Discovering a new JSON family or numeric format is a maintenance item; until a stable-version rule is established, inference returns `*` for that format and preserves the Yarn identity. A change in implementation alone does not close previously open Berry ranges.
