import { fetchMetadata, OFFICIAL_SOURCES } from '../../src/metadata.js'

import { browserMetadataFetcher } from './fetcher.js'
import { classifyError, type ErrorCode, WebsiteDataError } from './messages.js'

import type { SourceReceipt, UiCatalog } from './ui-types.js'
import type { CatalogOptions } from '../../src/types.js'

const labels: Record<string, [string, string]> = {
  node: ['Node 官方发行索引', 'version → Node 版本；npm → 该发行版绑定的 npm'],
  npm: ['npm 官方注册表 · npm', 'versions[版本].engines.node → 该 npm 版本声明的 Node 要求'],
  pnpm: ['npm 官方注册表 · pnpm', 'versions[版本].engines.node → 该 pnpm 版本声明的 Node 要求'],
  'yarn-classic': [
    'npm 官方注册表 · Yarn 历史发行版',
    'versions 中的 Classic 与历史 Berry 发行版；读取对应版本的 engines.node',
  ],
  'yarn-berry': ['npm 官方注册表 · Yarn Berry', 'versions 中的 Yarn >=2 <6；读取对应版本的 engines.node'],
  'yarn-cli': ['npm 官方注册表 · Yarn CLI', '补全历史 Yarn Berry 版本及 engines.node；此包不是独立可执行文件'],
  'yarn-tags': ['Yarn 官方版本列表', 'tags 中的已发布版本；注册表缺少的声明从对应官方 tag 读取'],
  'yarn-zpm': ['Yarn 官方原生发行索引', 'releaseLines.zpm 中的 Yarn >=6 原生版本；原生程序不声明宿主 Node 要求'],
}
export const CATALOG_SOURCES = OFFICIAL_SOURCES.map((source) => ({
  ...source,
  name: labels[source.id][0],
  fields: labels[source.id][1],
}))
export const emptyCatalog = (): UiCatalog => ({
  schemaVersion: 1,
  generatedAt: null,
  nodes: [],
  managers: { npm: [], pnpm: [], yarn: [] },
  sources: [],
  warnings: [],
})
export async function fetchOfficialCatalog({
  onSource,
  fetcher = browserMetadataFetcher,
  ...options
}: Omit<CatalogOptions, 'onSource'> & { onSource?: (source: SourceReceipt) => void } = {}): Promise<UiCatalog> {
  const failures: ErrorCode[] = []
  try {
    return await fetchMetadata({
      ...options,
      fetcher,
      onSource: (event) => {
        const source =
          CATALOG_SOURCES.find((s) => s.id === event.id)
          ?? (event.url === 'https://repo.yarnpkg.com/releases'
            ? {
                id: event.id,
                url: event.url,
                name: labels['yarn-zpm'][0],
                fields: labels['yarn-zpm'][1],
              }
            : {
                id: event.id,
                url: event.url,
                name: 'Yarn 官方 tag 的版本声明',
                fields: 'packages/yarnpkg-cli/package.json → version 与 engines.node',
              })
        const errorCode = event.error ? classifyError(event.error) : undefined
        if (errorCode) failures.push(errorCode)
        onSource?.({ ...source, ...event, errorCode })
      },
    })
  } catch (error) {
    throw new WebsiteDataError(failures.length ? failures : ['metadata'], error)
  }
}
