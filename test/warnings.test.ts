import assert from 'node:assert/strict'
import test from 'node:test'

import { formatWarning } from '../src/index.js'
import { resolvePlayground } from '../src/playground.js'
import { resolve } from '../src/resolve.js'
import { createSource } from '../src/sources.js'
import { createWarning } from '../src/warnings.js'
import { traceText, warningText } from '../website/src/messages.js'

import type { Catalog } from '../src/types.js'

const catalog: Catalog = {
  schemaVersion: 1,
  generatedAt: '2026-09-10T00:00:00Z',
  sources: [],
  warnings: [],
  nodes: [{ version: '24.10.0', npm: '11.6.1' }],
  managers: {
    npm: [{ version: '11.6.1', node: '>=20' }],
    pnpm: [
      { version: '10.21.0', node: '>=18' },
      { version: '9.15.9', node: '>=18' },
    ],
    yarn: [],
  },
}
const runtime = { node: '24.10.0', npm: '11.6.1', pnpm: '9.15.9' }

test('preferred-version warnings carry all selection parameters without parsing English', () => {
  const result = resolve({ runtime, sources: [createSource('packageManager', 'pnpm@^10')] }, catalog)
  const warning = result.warnings.find((item) => item.code === 'preferred-version-rejected')!
  assert.deepEqual(warning.params, {
    manager: 'pnpm',
    preferredVersion: '9.15.9',
    node: '24.10.0',
    selectedVersion: '10.21.0',
  })
  const text = warningText({
    ...warning,
    message: 'Completely revised English prose.',
    source: 'runtime',
    blockers: [],
  })
  assert.match(text, /pnpm@9\.15\.9.*Node 24\.10\.0.*10\.21\.0/)
  assert.match(text, /不满足/)
  assert.doesNotMatch(text, /revised English/)
})

test('invalid declarations expose a reason and preserve the rejected input in Chinese', () => {
  const value = '18.invalid+保留原文'
  const result = resolve({ runtime, sources: [createSource('remoteNode', value)] }, catalog)
  const warning = result.warnings.find((item) => item.code === 'invalid-declaration')!
  assert.deepEqual(warning.params, { reason: 'invalid-semver', value })
  const text = warningText({ ...warning, message: 'Different validation wording.', source: 'input.node', blockers: [] })
  assert.match(text, /无效.*semver/)
  assert.ok(text.includes(value))
})

test('unknown warnings retain the original message instead of losing diagnostic information', () => {
  const message = 'Future diagnostic: additional context.'
  assert.equal(warningText({ code: 'future-warning', message, source: 'runtime', blockers: [] }), message)
})

test('both locales render structured warnings without reading the English message', () => {
  const warning = createWarning('known-package-manager-bug', {
    manager: 'pnpm',
    version: '7.28.0',
    bugId: 'issue-123',
    url: 'https://example.test/123',
  })
  Object.defineProperty(warning, 'message', {
    get: () => {
      throw new Error('Do not parse prose')
    },
  })
  for (const locale of ['en', 'zh-CN'] as const) {
    const text = formatWarning(warning, locale)
    assert.ok(text.includes('pnpm@7.28.0'))
    assert.ok(text.includes('issue-123'))
    assert.ok(text.includes('https://example.test/123'))
    assert.equal(/在语义上兼容/.test(text), locale === 'zh-CN')
  }
})

test('calculator retains metadata parameters, timestamps and source locations through locale changes', () => {
  const result = resolvePlayground(
    { runtime, fields: {}, additional: [], searchDepth: 0 },
    {
      ...catalog,
      warnings: [
        createWarning(
          'stale-metadata',
          {
            source: 'node',
            detail: 'ECONNRESET',
            fetchedAt: '2026-09-09T01:02:03Z',
          },
          { path: 'https://nodejs.org/dist/index.json', fetchedAt: '2026-09-09T01:02:03Z' },
        ),
      ],
    },
    [],
  )
  const warning = result.warnings[0]
  assert.equal(warning.path, 'https://nodejs.org/dist/index.json')
  assert.equal(warning.fetchedAt, '2026-09-09T01:02:03Z')
  warning.message = 'No timestamp in the revised English message.'
  for (const locale of ['zh-CN', 'en']) {
    const text = warningText(warning, locale)
    assert.ok(text.includes('2026-09-09T01:02:03Z'))
    assert.ok(text.includes('ECONNRESET'))
    assert.equal(text.includes('缓存'), locale === 'zh-CN')
  }
})

test('invalid and conflicting trace entries use the same structured diagnostic as the warning panel', () => {
  const result = resolvePlayground(
    {
      runtime,
      fields: { remoteNode: 'invalid-node', packageManager: 'pnpm@10', yarnLock: 'v1' },
      additional: [],
      searchDepth: 0,
    },
    catalog,
    [],
  )
  const invalid = result.trace.find((source) => source.status === 'invalid')!
  assert.equal(invalid.warning?.params?.reason, 'invalid-semver')
  invalid.detail = 'Unrelated English sentence.'
  assert.match(traceText(invalid, 'zh-CN'), /无效.*semver.*invalid-node/)
  const ignored = result.trace.find((source) => source.status === 'ignored')!
  assert.equal(ignored.warning?.code, 'constraint-conflict')
  assert.match(traceText(ignored, 'zh-CN'), /更高优先级/)
})

test('legacy or incomplete dynamic warning payloads keep their original details', () => {
  for (const params of [undefined, { manager: 'pnpm' }]) {
    assert.equal(
      formatWarning({ code: 'preferred-version-rejected', message: 'Original details.', params }, 'zh-CN'),
      'Original details.',
    )
  }
})
