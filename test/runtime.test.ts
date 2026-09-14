import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'

import { detectRuntime } from '../src/runtime.js'

async function fixture(t: TestContext, version = '11.17.0') {
  const root = await mkdtemp(join(tmpdir(), 'nti-corepack-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'project')
  const bin = join(root, 'bin')
  await mkdir(cwd)
  await mkdir(join(cwd, '.git'))
  await mkdir(bin)
  const manifest = `${JSON.stringify({ packageManager: `pnpm@${version}` })}\n`
  await writeFile(join(cwd, 'package.json'), manifest)
  // An external command fixture models Corepack's cached project/default selection.
  const script = join(bin, 'manager.cjs')
  await writeFile(
    script,
    `
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
if (process.env.COREPACK_ENABLE_NETWORK !== '0' || process.env.COREPACK_ENABLE_AUTO_PIN !== '0') process.exit(2);
const manager = process.argv[2];
if (process.env.COREPACK_ENABLE_PROJECT_SPEC !== '0') {
  try {
    const pin = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).packageManager;
    if (pin) {
      const [name, version] = pin.split('@');
      if (name !== manager || version === '99.0.0') process.exit(1);
      console.log(version); process.exit(0);
    }
  } catch {}
}
console.log(manager === 'pnpm' ? '10.34.5' : '1.22.22');
`,
  )
  for (const manager of ['pnpm', 'yarn']) {
    const command = join(bin, `${manager}${process.platform === 'win32' ? '.cmd' : ''}`)
    await writeFile(
      command,
      process.platform === 'win32'
        ? `@"${process.execPath}" "${script}" ${manager} %*\r\n`
        : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", String.raw`'\''`)}' '${script.replaceAll("'", String.raw`'\''`)}' ${manager} "$@"\n`,
    )
    await chmod(command, 0o755)
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: [bin, dirname(process.execPath)].join(delimiter),
  }
  return { cwd, env, manifest }
}

test('cached project pnpm takes priority over the machine default without changing the manifest', async (t) => {
  const f = await fixture(t)
  const { runtime } = await detectRuntime({ cwd: f.cwd, env: f.env })
  assert.equal(runtime.pnpm, '11.17.0')
  assert.equal(runtime.yarn, '1.22.22')
  assert.equal(await readFile(join(f.cwd, 'package.json'), 'utf8'), f.manifest)
  assert.equal(f.env.COREPACK_ENABLE_AUTO_PIN, process.env.COREPACK_ENABLE_AUTO_PIN)
})

test('an uncached project version falls back to the available machine default', async (t) => {
  const f = await fixture(t, '99.0.0')
  const { runtime } = await detectRuntime({ cwd: f.cwd, env: f.env })
  assert.equal(runtime.pnpm, '10.34.5')
})

test('infer passes its target directory to runtime detection during metadata failure', async (t) => {
  const f = await fixture(t)
  const source = new URL('../src/index.ts', import.meta.url).href
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      `import { infer } from ${JSON.stringify(source)};
const result = await infer({ cwd: ${JSON.stringify(f.cwd)}, fetcher: async () => { throw new Error('offline'); } });
console.log(JSON.stringify({manager:result.packageManager,warnings:result.warnings.map(w=>w.code)}));`,
    ],
    { env: f.env },
  )
  const result = JSON.parse(stdout)
  assert.equal(result.manager.version, '11.17.0')
  assert.equal(result.manager.reason, 'exact')
  assert.ok(result.warnings.includes('metadata-unavailable'))
  assert.ok(!result.warnings.includes('constraint-conflict'))
})
