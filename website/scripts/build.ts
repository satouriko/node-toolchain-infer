import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const website = fileURLToPath(new URL('../', import.meta.url))

const result = await build({
  absWorkingDir: website,
  entryPoints: ['src/app.ts'],
  outfile: 'app.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  legalComments: 'linked',
  metafile: true,
})

const output = join(website, 'dist')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await Promise.all(
  [
    'index.html',
    'styles.css',
    'diagram.css',
    'data-plan.css',
    'app-shell.css',
    ...Object.keys(result.metafile.outputs),
  ].map((file) => copyFile(join(website, file), join(output, file))),
)
console.log('Built website/dist for static hosting. Run pnpm website:serve to open locally.')
