import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import semver from 'semver'

import { fetchCatalog } from '../src/catalog.js'
import { isStableVersion } from '../src/versions.js'

import { digest, type Fixture } from './model.js'
import { provision, type ProvisionOptions } from './provision.js'
import { detectFormat, execute, FormatDetectionError, hashes } from './runner.js'

import type { Catalog } from '../src/types.js'

export async function formatManifest(content: string): Promise<string> {
  const { ESLint } = await import('eslint')
  const root = fileURLToPath(new URL('../', import.meta.url))
  const results = await new ESLint({ cwd: root, fix: true, ignore: false }).lintText(content, {
    filePath: join(root, 'fixtures/generated/package.json'),
  })
  const result = results.at(0)
  if (!result || result.errorCount)
    throw new Error(`Fixture manifest formatting failed: ${JSON.stringify(result?.messages)}`)
  return result.output ?? content
}

export function pnpmGenerationPlan(fixture: Fixture): { command: string[]; files: Record<string, string> } {
  const command = ['install', '--ignore-scripts']
  if (fixture.match.features?.sharedWorkspace !== true) return { command, files: {} }
  // Official alpha.3 renamed the option; the workspace files are part of the generated fixture inputs.
  const option = semver.lt(fixture.version, '3.0.0-alpha.3')
    ? 'shared-workspace-shrinkwrap'
    : 'shared-workspace-lockfile'
  return {
    command: [...command, `--${option}`],
    files: { '.npmrc': `${option}=true\n`, 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' },
  }
}

export async function generateFixture(
  fixture: Fixture,
  catalog: Catalog,
  destination: string,
  options: ProvisionOptions = {},
): Promise<{ match: Fixture['match']; directory: string; lock?: string }> {
  if (!isStableVersion(fixture.version))
    throw new Error(`Prerelease generators are excluded: ${fixture.manager}@${fixture.version}`)
  const release = catalog.managers[fixture.manager].find((item) => item.version === fixture.version)
  if (!release) throw new Error(`Official release missing: ${fixture.manager}@${fixture.version}`)
  const temporary = await mkdtemp(join(tmpdir(), 'toolchain-generate-'))
  try {
    const tool = await provision(fixture.manager, release, catalog, join(temporary, 'tools'), fixture.node, options)
    const cwd = join(temporary, 'project')
    await mkdir(cwd)
    await writeFile(
      join(cwd, 'package.json'),
      await formatManifest(
        `${JSON.stringify({ name: 'compatibility-fixture', version: '1.0.0', private: true, dependencies: fixture.dependencies }, null, 2)}\n`,
      ),
    )
    const files = ['package.json', fixture.lock]
    if (fixture.manager === 'yarn' && semver.major(fixture.version) >= 2) {
      await writeFile(
        join(cwd, '.yarnrc.yml'),
        `${fixture.linker === 'pnp' ? '' : 'nodeLinker: node-modules\n'}enableScripts: false\nnpmRegistryServer: 'https://registry.npmjs.org'\n`,
      )
      files.push('.yarnrc.yml')
    }
    let command = ['install']
    if (fixture.manager === 'npm') command = ['install', '--ignore-scripts', '--no-audit', '--no-fund']
    else if (fixture.manager === 'pnpm') {
      const plan = pnpmGenerationPlan(fixture)
      command = plan.command
      for (const [file, content] of Object.entries(plan.files)) {
        await writeFile(join(cwd, file), content)
        files.push(file)
      }
    } else if (semver.major(fixture.version) < 2)
      command = ['install', '--ignore-scripts', '--non-interactive', '--registry', 'https://registry.npmjs.org']
    let result = await execute(tool, command, cwd, { YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' })
    let { output } = result
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'generation.log'), output)
    if (result.exitCode !== 0) {
      await writeFile(
        join(destination, 'failure.json'),
        JSON.stringify(
          {
            manager: fixture.manager,
            version: tool.version,
            node: tool.nodeVersion,
            nodeIntegrity: tool.nodeIntegrity,
            toolIntegrity: tool.integrity,
            toolUrl: tool.url,
            command,
            exitCode: result.exitCode,
            logPath: 'generation.log',
          },
          null,
          2,
        ),
      )
      throw new Error(`Generation failed (${result.exitCode}); ${destination}/generation.log: ${output}`)
    }
    if (fixture.lock === 'npm-shrinkwrap.json') {
      result = await execute(tool, ['shrinkwrap'], cwd)
      output += result.output
      if (result.exitCode !== 0) throw new Error(`Shrinkwrap generation failed: ${output}`)
    }
    let { lock } = fixture
    let match: Fixture['match'] | null = null
    let formatError: Error | undefined
    try {
      let content: string
      try {
        content = await readFile(join(cwd, lock), 'utf8')
      } catch (error) {
        if (fixture.manager !== 'pnpm' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const alternative = fixture.lock === 'shrinkwrap.yaml' ? 'pnpm-lock.yaml' : 'shrinkwrap.yaml'
        content = await readFile(join(cwd, alternative), 'utf8')
        lock = alternative
      }
      files[1] = lock
      match = detectFormat(fixture.manager, content, lock)
    } catch (error) {
      formatError = error instanceof FormatDetectionError ? error : new FormatDetectionError(fixture.manager, error)
    }
    await mkdir(destination, { recursive: true })
    for (const file of files) {
      try {
        await cp(join(cwd, file), join(destination, file))
      } catch (error) {
        if (file !== lock || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const fileHashes = await hashes(destination, files)
    await writeFile(join(destination, 'generation.log'), output)
    await writeFile(
      join(destination, 'receipt.json'),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), manager: fixture.manager, version: tool.version, node: tool.nodeVersion, nodeArch: tool.nodeArch, bootstrap: tool.bootstrap, nodeIntegrity: tool.nodeIntegrity, toolIntegrity: tool.integrity, toolUrl: tool.url, platform: process.platform, arch: process.arch, command, requestedLock: fixture.lock, lock, postCommand: fixture.lock === 'npm-shrinkwrap.json' ? ['shrinkwrap'] : [], match, formatError: formatError ? String(formatError) : undefined, files: fileHashes, fixtureHash: digest(JSON.stringify(fileHashes)), logPath: 'generation.log' }, null, 2)}\n`,
    )
    if (formatError) throw formatError
    if (!match) throw new Error('Format detection did not return a match')
    return { match, directory: destination, lock }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
export async function generateFixtures(root = process.cwd()): Promise<void> {
  const recipes = JSON.parse(await readFile(join(root, 'fixtures/recipes.json'), 'utf8')) as Fixture[]
  const catalogArgument = process.argv.indexOf('--catalog')
  const catalog =
    catalogArgument !== -1
      ? (JSON.parse(await readFile(process.argv[catalogArgument + 1], 'utf8')) as Catalog)
      : await fetchCatalog()
  for (const fixture of recipes) {
    if (!isStableVersion(fixture.version)) {
      console.log(`Preserved historical prerelease recipe ${fixture.id}; generation skipped`)
      continue
    }
    const destination = join(root, 'fixtures', fixture.directory)
    // Published recipes are immutable; regenerations go to a new directory explicitly.
    try {
      await readFile(join(destination, 'receipt.json'))
      console.log(`Preserved ${fixture.id}`)
      continue
    } catch {}
    console.log(`Generating ${fixture.id} with ${fixture.manager}@${fixture.version}`)
    const result = await generateFixture(fixture, catalog, destination)
    if (JSON.stringify(result.match) !== JSON.stringify(fixture.match))
      throw new Error(`Recipe format mismatch for ${fixture.id}: ${JSON.stringify(result.match)}`)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generateFixtures().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 2
  })
}
