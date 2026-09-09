import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
}
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep) || path.includes(`${sep}node_modules${sep}`)) {
      res.writeHead(403).end()
      return
    }
    if (!(await stat(path)).isFile()) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      'Content-Type': mime[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    res.end(await readFile(path))
  } catch {
    res.writeHead(404).end('Not found')
  }
})
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => {
  const address = server.address()
  if (address && typeof address === 'object') console.log(`node-toolchain-infer: http://127.0.0.1:${address.port}`)
})
