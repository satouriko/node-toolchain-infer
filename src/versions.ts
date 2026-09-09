import semver from 'semver'

/** Build metadata is allowed; alpha, beta, rc and all other prereleases are excluded. */
export function isStableVersion(version: unknown): boolean {
  return typeof version === 'string' && !!semver.valid(version) && semver.prerelease(version) === null
}

/** Prerelease cores admitted by standard semver matching, including OR clauses. */
export function prereleaseCores(range: string): string[] {
  const cores = new Set<string>()
  for (const clause of new semver.Range(range).set) {
    for (const comparator of clause) {
      const version = comparator.semver
      if (!(version instanceof semver.SemVer) || !version.prerelease.length) continue
      const core = `${version.major}.${version.minor}.${version.patch}`
      const interval = `${clause.map((c) => c.value).join(' ')} >=${core}-0 <${core}`
      // Generated exclusive bounds such as <19.0.0-0 do not admit prereleases.
      if (semver.minVersion(interval)) cores.add(core)
    }
  }
  return [...cores]
}
