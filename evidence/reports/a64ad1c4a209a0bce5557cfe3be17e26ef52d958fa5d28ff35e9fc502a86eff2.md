# Compatibility release check

Generated: 2026-09-23T08:42:11.644Z

Exit code: 2 (0 complete, 1 maintenance required, 2 incomplete)

- npm: 527/529 stable releases have conclusive observations for every recipe.
- pnpm: 833/987 stable releases have conclusive observations for every recipe.
- yarn: 169/199 stable releases have conclusive observations for every recipe.

## unknownFormats

None.

## mismatches

None.

## unresolved

None.

## incomplete

- npm@12.1.0: Error: Shrinkwrap generation failed: npm warn Unknown env config "verify-deps-before-run". This will error in a future major version of npm. See `npm help npmrc` for supported config options.
npm warn Unknown env config "npm-globalconfig". This will error in a future major version of npm. See `npm help npmrc` for supported config options.
npm warn Unknown env config "_jsr-registry". This will error in a future major version of npm. See `npm help npmrc` for supported config options.
npm warn Unknown env config "store-dir". This will error in a future major version of npm. See `npm help npmrc` for supported config options.
npm warn Unknown env config "store". This will error in a future major version of npm. See `npm help npmrc` for supported config options.
npm warn Unknown env config "store-path". This will error in a future major version of npm. See `npm help npmrc` for supported config options.

added 1 package in 407ms
Unknown command: "shrinkwrap"

To see a list of supported npm commands, run:
  npm help
; logs/failure-8d2abcb9-f6b7-45d8-aab1-19303a5e0905.log

## Incremental check

3 releases checked this run; 1715 exact artifacts have recorded results.
Previous failures are retained in [history.md](history.md) and history.json; they are not rerun or relabeled as compatible.

Reproduce with the catalog.json, observations.json, state.json and logs in this artifact; see maintenance/update-compatibility.prompt.md. Historical point observations do not establish compatibility boundaries.
