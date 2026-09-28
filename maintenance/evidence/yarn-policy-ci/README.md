# Yarn policy and targeted CI retry verification

On 2026-09-28, the state from [failed maintenance run 36115432991](https://github.com/satouriko/node-toolchain-infer/actions/runs/36115432991) was replayed locally with the approved Yarn policies. The immutable source evidence commit is `c46f5135ff64a72b8d261d7936377e93a3472ff1` on `compatibility-data`.

- Classic v1: `>=0.21.0 <2.1.0`, using the adopted project support floor.
- Modern v7: no supported stable release, represented by `<0.0.0`.
- Only `yarn@4.18.1` ran: eight fixture observations, all conclusive. Its v1/v7 rejections are expected; v10 passes. The check changed from exit 1 to exit 0, with no new mismatches or incomplete checks.
- All 12,531 prior observations and the original failure receipt were preserved. Results for the other 1,715 recorded releases were unchanged. Historical pnpm findings remain in the original state.
- This was a local replay on Node 24.10.0, macOS arm64. It is not a new Linux GitHub Actions run.

The [summary](summary.json) records the catalog and shipped-rule hashes. `observations.json`, `checks/`, `logs/`, and `generated/` retain only this retry's new evidence; retrieve the full historical catalog/state from the source commit when reproducing. Original outcomes were not relabeled.

Run against a copy of that preserved evidence state:

```sh
pnpm releases:check --incremental --retry-failed \
  --manager yarn --version 4.18.1 \
  --catalog ORIGINAL/catalog.json --state-dir RETRY \
  --seed-dir NO_ADDITIONAL_SEED_DIRECTORY
```

`NO_ADDITIONAL_SEED_DIRECTORY` is a deliberately absent path: all historical attempts are already in the restored state. The full catalog is retained; the version option restricts execution only. No old-version installations were rerun. Existing stable-only points for the two affected formats were checked against the adopted ranges with no conclusive contradictions.

Verification also passed 310 automated tests, type checking, lint, and validation of all 23 shipped rules. Regression coverage checks both compilation entry points, preservation of unknown historical evidence, expected and unexpected CI outcomes, and exact-version retry isolation with preserved receipts.
