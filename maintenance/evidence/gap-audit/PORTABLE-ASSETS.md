# Portable evidence assets

`importSeedMonitor` reads an optional `portable-assets.json` beside a seed directory's `rows/`. It maps the exact asset paths retained in immutable observations to files inside that evidence directory:

```json
{
  "schemaVersion": 1,
  "assets": {
    "/original/host/cache/bootstrap.log": {
      "path": "bootstrap/archived-bootstrap.log",
      "sha256": "<SHA256 of the archived file bytes>"
    }
  }
}
```

Mappings apply to install logs, frozen-control logs, bootstrap dependency locks, and bootstrap logs. Relative source paths can also be mapped to pin their bytes. A mapped path takes precedence over the original location, must remain inside the evidence directory, and must match its recorded SHA256. Invalid mappings or changed bytes produce incomplete imports; the importer does not fall back to the original host path in those cases. Unmapped paths retain the existing path-resolution behavior.

The importer archives the original mapping and original row bytes separately. Imported observations receive portable asset locations; observation fingerprints continue to bind the same commands, inputs, results, runtime, and bootstrap manifests.

The Yarn and pnpm mappings in this directory were generated from the additional standard rows and their archived assets. Yarn's former absolute bootstrap paths use the files already identified by `bootstrap-archive-manifest.json`; source rows were not rewritten.
