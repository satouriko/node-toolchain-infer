# Compatibility maintenance repair verification

On 2026-09-10, pnpm 4.12.3 was retested using its original official tarball with the existing opt-in dependency bootstrap. The bootstrap lock and log are retained in `bootstrap/`; raw attempts and frozen-control receipts are in `rows/`, with command output in `logs/`. No tool source or fixture bytes were patched.

All nine fixtures have conclusive outcomes: five passed and four explicitly rejected incompatible formats. `summary.json` records exit code 0 with no unattempted or inconclusive combinations. These are raw outcomes, not a new inferred version range.

Reproduction command:

```sh
pnpm data:seed --catalog maintenance/evidence/compat-maintenance-repair/catalog.json --output maintenance/results/retest-4.12.3 --versions pnpm@4.12.3 --concurrency 1
```
