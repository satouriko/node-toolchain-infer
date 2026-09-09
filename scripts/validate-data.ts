import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { validateCompatibility } from '../src/data-validation.js'

export { validateCompatibility } from '../src/data-validation.js'

export async function validateData({
  compatibilityPath = new URL('../data/compatibility.json', import.meta.url),
}: { compatibilityPath?: string | URL } = {}) {
  return validateCompatibility(JSON.parse(await readFile(compatibilityPath, 'utf8')))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = await validateData()
  console.log(`Validated ${data.rules.length} compatibility rules.`)
}
