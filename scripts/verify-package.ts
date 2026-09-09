import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const argument = process.argv[2]
if (!argument || process.argv.length !== 3) throw new Error('Usage: tsx scripts/verify-package.ts package.tgz')
const tarball = resolve(argument)
const { stdout } = await exec('tar', ['-tzf', tarball])
const files = stdout.trim().split('\n')
const allowed = new Set([
  'package/package.json',
  'package/LICENSE',
  'package/README.md',
  'package/README.zh-CN.md',
  'package/data/compatibility.json',
])
assert.ok(
  files.every((file) => allowed.has(file) || file.startsWith('package/dist/')),
  'Unexpected published file',
)
for (const file of ['index.js', 'index.d.ts', 'catalog.js', 'catalog.d.ts', 'resolve.js', 'resolve.d.ts', 'cli.js']) {
  assert.ok(files.includes(`package/dist/${file}`), `Missing ${file}`)
}
assert.ok(files.includes('package/data/compatibility.json'), 'Missing compiled compatibility data')

const consumer = await mkdtemp(join(tmpdir(), 'node-toolchain-infer-package-'))
try {
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  await exec(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--registry=https://registry.npmjs.org',
      tarball,
    ],
    { cwd: consumer, timeout: 120_000 },
  )
  await writeFile(
    join(consumer, 'smoke.mjs'),
    `import assert from 'node:assert/strict'
import { infer } from 'node-toolchain-infer'
import { loadRules } from 'node-toolchain-infer/data'
import { resolve } from 'node-toolchain-infer/resolve'
import { formatWarning } from 'node-toolchain-infer/warnings'

assert.equal(typeof resolve, 'function')
assert.ok((await loadRules()).length > 0)
const result = await infer({
  cwd: process.cwd(),
  node: '18',
  packageManager: 'pnpm@9',
  runtime: { node: '18.20.8', npm: '10.8.2', pnpm: '9.15.9' },
  catalog: {
    schemaVersion: 1, generatedAt: '2026-09-09T00:00:00Z', sources: [], warnings: [],
    nodes: [{ version: '18.20.8', npm: '10.8.2' }],
    managers: {
      npm: [{ version: '10.8.2', node: '>=18.17.0' }],
      pnpm: [{ version: '9.15.9', node: '>=18.12' }], yarn: [],
    },
  },
})
assert.equal(result.node?.version, '18.20.8')
assert.equal(result.packageManager?.name, 'pnpm')
assert.equal(result.packageManager?.version, '9.15.9')
const warning = result.warnings.find(item => item.code === 'git-root-not-found')
assert.ok(warning)
assert.match(formatWarning({ ...warning, message: 'Changed English text' }, 'zh-CN'), /Git.*起始目录/)
`,
  )
  await exec(process.execPath, ['smoke.mjs'], { cwd: consumer, timeout: 30_000 })
  const cli = join(consumer, 'node_modules/node-toolchain-infer/dist/cli.js')
  const help = await exec(process.execPath, [cli, '--help'], { cwd: consumer, timeout: 30_000 })
  assert.match(help.stdout, /node-toolchain-infer \[--cwd directory\]/)
  console.log(
    `Verified ${files.length} packed files, all public imports, bundled rules, inference and CLI on Node ${process.versions.node}.`,
  )
} finally {
  await rm(consumer, { recursive: true, force: true })
}
