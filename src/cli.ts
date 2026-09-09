#!/usr/bin/env node
import process from 'node:process'

import { infer, type InferOptions, loadCatalog } from './index.js'

import { errorMessage } from './validation.js'

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(`node-toolchain-infer [--cwd directory] [--node range] [--package-manager name@range] [--catalog file] [--json]

Read declarations from cwd through its nearest Git root and infer Node and npm/pnpm/Yarn.
Inputs accept semver ranges. Official metadata is refreshed in memory on each call.
Automatic inference uses stable versions only; explicit versions and ranges can admit prereleases.
--catalog uses an explicit previously downloaded metadata snapshot.
Conflicting declarations produce warnings, not fatal errors.`)
} else {
  try {
    const options: InferOptions = {}
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]
      if (flag === '--json') continue
      if (!['--cwd', '--node', '--package-manager', '--catalog'].includes(flag))
        throw new Error(`Unknown option: ${flag}`)
      const value = args[++index]
      if (!value) throw new Error(`Missing value for ${flag}`)
      if (flag === '--cwd') options.cwd = value
      if (flag === '--node') options.node = value
      if (flag === '--package-manager') options.packageManager = value
      if (flag === '--catalog') options.catalog = await loadCatalog(value)
    }
    const result = await infer(options)
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(
        result.node && result.packageManager
          ? `Node ${result.node.version} + ${result.packageManager.name} ${result.packageManager.version}`
          : 'No runnable version pair was found.',
      )
      for (const warning of result.warnings) console.error(`[${warning.code}] ${warning.message}`)
    }
    if (!result.node || !result.packageManager) process.exitCode = 1
  } catch (error) {
    console.error(errorMessage(error))
    process.exitCode = 1
  }
}
