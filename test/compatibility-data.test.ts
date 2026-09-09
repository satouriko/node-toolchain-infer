import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import semver from 'semver'

import { rulesFrom } from '../src/data-validation.js'
import { resolve } from '../src/resolve.js'

import type { Catalog, Manager } from '../src/types.js'

const rules = rulesFrom(JSON.parse(await readFile(new URL('../data/compatibility.json', import.meta.url), 'utf8')))

function infer(manager: Manager, version: string, format: string, file: string) {
  const catalog: Catalog = {
    schemaVersion: 1,
    generatedAt: '',
    sources: [],
    warnings: [],
    nodes: [{ version: '18.20.8', npm: '10.8.2' }],
    managers: { npm: [], pnpm: [], yarn: [] },
  }
  // Isolate the shipped compatibility policy from network/runtime metadata.
  catalog.managers[manager] = [{ version, node: '*' }]
  return resolve(
    {
      runtime: { node: '18.20.8', npm: '10.8.2', [manager]: version },
      sources: [
        {
          id: 'lock',
          kind: file,
          target: 'lock',
          manager,
          value: format,
          format,
          path: `/project/${file}`,
          depth: 0,
          rank: 4,
        },
      ],
    },
    catalog,
    rules,
  )
}

test('shipped data retains the audited pnpm stable gaps and warns for installer bugs', () => {
  for (const format of ['5', '5.1', '5.2', '5.3', '5.4']) {
    const result = infer('pnpm', '5.17.0', format, 'pnpm-lock.yaml')
    assert.equal(result.packageManager?.version, '5.17.0', format)
    assert.ok(
      result.warnings.some((warning) => warning.code === 'known-package-manager-bug'),
      format,
    )
  }
  for (const version of ['7.33.0', '7.33.7', '9.0.0', '9.0.5']) {
    const result = infer('pnpm', version, '6.0', 'pnpm-lock.yaml')
    assert.equal(result.packageManager?.version, version)
    assert.equal(
      result.warnings.some((warning) => warning.code === 'known-package-manager-bug'),
      version.startsWith('9.'),
    )
  }
})

test('shipped ranges keep real rejections and exclude prereleases', () => {
  const rule = (manager: Manager, format: string, file: string) => {
    const found = rules.find(
      (candidate) =>
        candidate.manager === manager && String(candidate.match.format) === format && candidate.match.file === file,
    )
    assert.ok(found?.range, `${manager} ${file} ${format}`)
    return { ...found, range: found.range }
  }
  const pnpm6 = rule('pnpm', '6.0', 'pnpm-lock.yaml')
  assert.ok(pnpm6)
  for (const version of ['8.0.0-alpha.0', '8.0.0-beta.1', '9.0.0-rc.0'])
    assert.equal(semver.satisfies(version, pnpm6.range), false, version)
  for (const version of ['9.0.0-alpha.5', '9.0.0-beta.3', '10.0.0'])
    assert.equal(semver.satisfies(version, pnpm6.range), false, version)
  const pnpm9 = rule('pnpm', '9.0', 'pnpm-lock.yaml')
  for (const version of ['9.1.0', '9.2.0', '9.3.0', '9.4.0', '12.0.0'])
    assert.ok(semver.satisfies(version, pnpm9.range), version)
  assert.equal(semver.satisfies('12.0.0-alpha.0', pnpm9.range), false)
  assert.equal(semver.satisfies('13.0.0-alpha.0', pnpm9.range), false)
  assert.ok(semver.satisfies('13.0.0', pnpm9.range))
  assert.equal(semver.satisfies('12.0.0', rule('npm', '3', 'npm-shrinkwrap.json').range), false)
})

test('npm ci validation bugs preserve v3 compatibility with a visible marker', () => {
  for (const file of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const result = infer('npm', '7.10.0', '3', file)
    assert.equal(result.packageManager?.version, '7.10.0')
    assert.ok(result.warnings.some((warning) => warning.code === 'known-package-manager-bug'))
  }
})

test('all published compatibility and bug bounds are stable versions', () => {
  for (const rule of rules) {
    for (const range of [rule.range, ...(rule.knownBugs ?? []).map((bug) => bug.range)]) {
      if (range === null) continue
      for (const group of new semver.Range(range).set)
        for (const comparator of group)
          if (comparator.value) assert.equal(comparator.semver.prerelease.length, 0, `${rule.id}: ${range}`)
    }
  }
})
