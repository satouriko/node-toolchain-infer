import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { fetchCatalog } from '../src/catalog.js'

import type { CatalogOptions } from '../src/types.js'

export async function syncData({ output, ...options }: CatalogOptions & { output: string }) {
  const catalog = await fetchCatalog(options)
  await mkdir(dirname(output), { recursive: true })
  const temporary = `${output}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`)
    await rename(temporary, output)
  } finally {
    await rm(temporary, { force: true })
  }
  return catalog
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[process.argv.indexOf('--output') + 1]
  if (!process.argv.includes('--output') || !output) {
    console.error('Usage: pnpm data:sync --output path/to/catalog.json')
    process.exitCode = 1
  } else await syncData({ output })
}
