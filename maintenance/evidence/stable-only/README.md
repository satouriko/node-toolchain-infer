# Stable-only compatibility data

This output compiles the preserved installation evidence under the stable-only policy. It does not rerun or overwrite historical installations. Only SemVer versions without prerelease identifiers contribute to compilation, statistics and new maintenance runs. Exact prerelease declarations remain available through runtime metadata queries; they do not establish lockfile compatibility evidence.

The compiled table contains 21 rules for 23 fixture formats. Yarn Classic v1 and Modern format 7 remain uncompiled and use the existing unknown `*` policy. There are 13,574 stable version/fixture points: 4,075 supported, 1,441 unknown, 8,058 unsupported. Unknown observations remain unknown; the compiler therefore exits 2. The audit reports no supported/excluded or unsupported/included contradictions. Its 31 internal unknown runs (36 points) are all included by the permissive range policy, so they do not create exclusions in the version ranges.

The active bug registry contains 5 families affecting stable releases. Three prerelease-only reviews were removed: `npm-ci-unwanted-save-1811`, `pnpm-frozen-rewrite-8-prerelease`, `yarn-node17-tar-stream-3597`. Their complete prior reviews and installation evidence remain in `../gap-audit/compiled/report.json` and its referenced archives. Mixed-family historical reviews are preserved; published bug bounds contain only stable version comparators.

Reproduce compilation (exit 2 retains honest unknown outcomes):

```sh
pnpm data:compile \
  --catalog maintenance/evidence/yarn-pnp-matrix/catalog.json \
  --recipes fixtures/recipes.json --fixtures-root fixtures \
  --evidence maintenance/evidence/initial-matrix \
  --evidence maintenance/evidence/initial-boundaries \
  --evidence maintenance/evidence/yarn-supplement \
  --evidence maintenance/evidence/yarn-pnp-matrix \
  --evidence maintenance/evidence/yarn-boundaries \
  --evidence maintenance/evidence/legacy-pnpm-boundaries \
  --evidence maintenance/evidence/npm-v3-controls \
  --evidence maintenance/evidence/gap-audit/pnpm \
  --evidence maintenance/evidence/gap-audit/yarn \
  --output maintenance/evidence/stable-only
pnpm data:audit \
  --report maintenance/evidence/stable-only/report.json \
  --json maintenance/evidence/stable-only/inventory.json \
  --markdown maintenance/evidence/stable-only/inventory.md
```
