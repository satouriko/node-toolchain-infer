import unicute, { globals } from 'eslint-config-unicute'

export default unicute(
  {
    node: ['src/{catalog,cli,collect,index,runtime}.ts', 'scripts/**/*.ts', 'maintenance/**/*.ts'],
    // Array.prototype.toSorted requires Node 20; published code supports Node 18.
    rules: { 'unicorn/no-array-sort': 'off' },
  },
  // Generated raw receipts and official response bytes are checked by the evidence pipeline.
  // Fixture manifests remain linted; only append-only measurement output is excluded.
  { ignores: ['maintenance/evidence/**'] },
  // The published executable is emitted from this TypeScript entry point.
  { files: ['src/cli.ts'], rules: { 'n/hashbang': ['error', { additionalExecutables: ['src/cli.ts'] }] } },
  { files: ['website/src/**/*.ts'], languageOptions: { globals: globals.browser } },
)
