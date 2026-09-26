# Compatibility release check

Generated: 2026-09-25T08:55:49.217Z

Exit code: 1 (0 complete, 1 maintenance required, 2 incomplete)

- npm: 528/529 stable releases have conclusive observations for every recipe.
- pnpm: 833/987 stable releases have conclusive observations for every recipe.
- yarn: 170/200 stable releases have conclusive observations for every recipe.

## unknownFormats

None.

## mismatches

- yarn@4.18.1 yarn-classic-v1: incompatible, expected undefined (unestablished); logs/7d967ee2676fef7cf821a8544acce422cadcdbbed754c998909b74303f76d0ec-e20b045c4e55.log
- yarn@4.18.1 yarn-modern-v7: incompatible, expected undefined (unestablished); logs/52ac1d82cb6781542659f27992293bb1961700cf3b54509189effc0b4bc8a14c-83afcd484233.log

## unresolved

- yarn@4.18.1 yarn-classic-v1: incompatible, expected undefined (unestablished); logs/7d967ee2676fef7cf821a8544acce422cadcdbbed754c998909b74303f76d0ec-e20b045c4e55.log
- yarn@4.18.1 yarn-modern-v7: incompatible, expected undefined (unestablished); logs/52ac1d82cb6781542659f27992293bb1961700cf3b54509189effc0b4bc8a14c-83afcd484233.log

## incomplete

None.

## Incremental check

1 releases checked this run; 1716 exact artifacts have recorded results.
Previous failures are retained in [history.md](history.md) and history.json; they are not rerun or relabeled as compatible.
- Historical unresolved: pnpm@9.0.5 pnpm-lock-v6: rewrite, expected true (rule); logs/a4973009e91019d8d4d63d69b8556496052f3952e60779505da4cec17b4b55fc-5cc4b3129705.log
- Historical unresolved: pnpm@9.0.5:38110ce2f432ab70851c19999068683384a7b027599811045a942561522d1ded: conflicting initial observations 9c40d45d4229bd8799ed6bc1110f197c7528230b8629ce80855975e8164b96c4-0ee3e36b4b7b, 8d5c16aef125e237cbc468b764bd0b1099338dd7cec6d4577a5e66d76b8c7fdb-b91290686213, a4973009e91019d8d4d63d69b8556496052f3952e60779505da4cec17b4b55fc-5cc4b3129705
- Historical unresolved: pnpm@9.0.5 pnpm-lock-v6: initial observation a4973009e91019d8d4d63d69b8556496052f3952e60779505da4cec17b4b55fc-5cc4b3129705 (rewrite) disagrees with current rule initial-eb5697865755b60f; logs/a4973009e91019d8d4d63d69b8556496052f3952e60779505da4cec17b4b55fc-5cc4b3129705.log

Reproduce with the catalog.json, observations.json, state.json and logs in this artifact; see maintenance/update-compatibility.prompt.md. Historical point observations do not establish compatibility boundaries.
