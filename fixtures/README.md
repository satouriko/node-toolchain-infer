# Real generated fixtures

The 23 recipes install the registry package `is-number@7.0.0` and freeze in clean temporary projects. Lockfiles were produced by exact released tools. Each `receipt.json` records generation provenance; `generation.log` records real output. No lock format numbers were hand-edited.

| Fixture family         | Format                   | Exact generator                                |
| ---------------------- | ------------------------ | ---------------------------------------------- |
| npm package-lock       | 1 / 2 / 3                | 6.14.18 / 7.24.2 / 10.8.2                      |
| npm shrinkwrap         | 1 / 2 / 3                | 6.14.18 / 7.24.2 / 10.8.2, then npm shrinkwrap |
| pnpm legacy shrinkwrap | 3 / 4 (shared workspace) | 2.25.7                                         |
| pnpm lock              | 5 / 5.1 / 5.2 / 5.3      | 3.0.0 / 3.8.1 / 5.18.11 / 6.0.0                |
| pnpm lock              | 5.4 / 6.0 / 9.0          | 7.33.7 / 8.15.9 / 9.15.9                       |
| Yarn Classic           | 1                        | 1.22.22                                        |
| Yarn Modern            | 4 / 5 / 6 / 7            | 2.4.3 / 3.1.0 / 3.8.7 / 4.0.0-rc.35            |
| Yarn Modern            | 8 / 9 / 10               | 4.9.2 / 4.14.0 / 4.18.0                        |

Every recipe has an exact-generator frozen baseline pass, unchanged input hashes, and verification of the installed dependency version. Initial evidence is in `maintenance/evidence/observations.json`; expansion evidence is in `maintenance/evidence/format-discovery/`, including the original coverage report and hash audit. Updated Modern PnP baselines are in `maintenance/evidence/yarn-pnp-baselines/`, and early Yarn 2 generation probes are in `maintenance/evidence/early-yarn-discovery/`. Each audit applies only to its recorded fixture hashes. Exact runtime versions, architectures and official integrity receipts are retained. The original nine measurements use Node 24.10.0 on macOS arm64; expansion probes use catalog-selected historical runtimes, including official x64 Node through Rosetta when required.

The lock9 boundary was additionally tested using pnpm 8.15.9 (incompatible) and 9.0.0 (pass), on both Node 24.10.0 and checksummed official Node 18.20.8. Discovery of a format alone does not establish a compatibility range; compiled rules require separate release-boundary evidence. Filename-specific matches keep npm shrinkwrap separate from package-lock and legacy pnpm shrinkwrap separate from pnpm-lock.

The legacy pnpm format 4 fixture enables the real shared-workspace configuration and verifies the root importer dependency. It does not establish nested workspace dependency behavior. Legacy version 3 preserves its original generation receipt's parser limitation and links to the subsequent real frozen pass in the adoption record.

Coverage gaps remain for nested workspaces, peer/optional/platform dependencies, patches, overrides, git/file/tarball dependencies, alternative linkers and registries, and Yarn cache-key variants. An additional pnpm 3.0.0-alpha.0 legacy shrinkwrap version 5 sample remains an investigatory probe. Other unsampled formats may exist. Add a real recipe and generation evidence before claiming coverage. Existing receipts are never proof for a modified fixture hash.

Current Modern recipes use `pnp/` with only `enableScripts` and `npmRegistryServer` settings. This avoids rejecting old Yarn before it reads the lockfile. The verifier resolves the exact dependency package version through the generated PnP loader. Previous `basic/` fixtures and their receipts stay unchanged for historical reproduction.

Each current recipe includes `controlDependencies`: the control requests `is-number@6.0.0` while retaining the original lock that pins 7.0.0. A positive observation also requires a control on the same exact tool and Node: it must explicitly reject the contradictory manifest, or successfully retain the original locked dependency versions without changing any watched input or lockfile. Installing the newly requested versions does not prove lock enforcement. The baseline and nested `frozenControl` retain independent commands, input hashes and logs. Older positive observations without this control remain historical evidence and are rechecked; unchanged negative observations need no such positive-proof control. Initial exploratory controls under `maintenance/evidence/frozen-controls/` exposed early pnpm releases that silently ignored locks.

Frozen installation uses each pnpm release’s historical option: `--frozen-shrinkwrap` before `3.0.0-alpha.3`, then `--frozen-lockfile`. The option is selected by the tested manager version for both lockfile names. An ignored option cannot establish support because the contradictory-manifest control must also pass.

The two npm v2 recipes use npm 8.19.4 on Node 16.10.0 as their generator/baseline. It reproduced both original v2 inputs byte for byte and passed the frozen control. The original npm 7.24.2 control silently installed the contradictory version, so it remains inconclusive. Original and replacement generation receipts, comparisons and control logs are retained in `maintenance/evidence/npm-v2-baseline/`; no tested input bytes or fixture hashes changed.
