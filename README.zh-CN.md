# node-toolchain-infer

从调用方输入、项目文件和锁文件兼容数据，推断项目的 Node.js 与 npm、pnpm、Yarn 版本。包的宿主要求 **Node.js ≥18**，不考虑 Bun、Deno 等其他运行时。

[English](README.md) · [网站与计算器](https://satouriko.github.io/node-toolchain-infer/) · [数据维护方法](maintenance/README.md) · [人和 AI 共用的维护说明](maintenance/update-compatibility.prompt.md)

已知安装 bug 可能导致冻结安装测试失败，但不影响该版本对锁格式的语义兼容性。审核过的例外保留原始失败记录，兼容版本仍可选择；选中时返回 `known-package-manager-bug` 提示。完整测试证据索引保存在维护仓库，不随 npm 包发布。

用户显式指定的精确版本和 semver 范围一视同仁：被采纳的 API、CLI 或项目文件声明允许匹配的预发布版，且只对该工具生效。范围按标准 semver 匹配；`pnpm@10.0.0-rc.1` 和 `pnpm@>=10.0.0-rc.1 <10.0.0` 都可以选中 pnpm 预发布版。由它推导 Node 时仍**只考虑稳定版**，除非 Node 自己的显式声明也允许预发布版。锁文件推断、无匹配声明时的本地兜底、版本统计和兼容数据维护仍只考虑稳定版。

```ts
import { infer } from 'node-toolchain-infer'

const result = await infer({
  cwd: '/path/to/project',
  node: '>=18 <23',
  packageManager: 'pnpm@^9',
})

console.log(result.node?.version, result.packageManager?.version)
console.log(result.warnings, result.trace)
```

输入接受任意合法 semver 范围：`18`、`18.20`、完整版本、比较运算符、`||` 等。版本声明冲突或格式无效时，产生警告，忽略优先级较低的条件。完整版本相当于单元素范围，不改变来源优先级。

从指定目录（默认当前目录）的真实路径向上读取，包含最近的 Git 根目录；识别 worktree 的 `.git` 文件。找不到 Git 根目录时，只读取起始目录并警告。先比较目录距离，同一目录内依次读取：

1. `package.json#packageManager`
2. `pnpm-lock.yaml`、`shrinkwrap.yaml`、`yarn.lock`、`npm-shrinkwrap.json`、`package-lock.json`
3. `volta.node`、`.node-version`、`.nvmrc`、`.tool-versions` 的 `nodejs`
4. `devEngines.runtime` 中的 Node、`devEngines.packageManager`
5. `engines.node`、选定包管理器对应的 `engines` 条件

调用方输入高于所有文件；同序号的重复项按出现顺序处理。每个包管理器候选与自身的 `engines.node` 一起进入优先级判断，冲突时一起忽略。

Node 依次采用：保留的具体版本、满足条件的当前版本、范围内最大的已发布版本。包管理器依次采用：保留的具体版本、所选 Node 绑定的 npm／本地 pnpm 或 Yarn、范围内最大的可运行版本。无类型声明时默认 npm，不写死任何 Node/npm 兜底版本。

## 版本数据

每次 `infer()` 获取或重新验证八个官方接口：Node 发行索引，npm 注册表中的 npm、pnpm、yarn、`@yarnpkg/cli-dist`、`@yarnpkg/cli`，以及 Yarn 官方 Berry tags 和 [release lines](https://repo.yarnpkg.com/releases)。Yarn 支持 Classic（<2）、Berry（>=2 <6）和原生 Yarn 6+（`yarnpkg/zpm`）。原生版本取 `releaseLines.zpm.tags`、`stable`、`canary` 的并集并去重，按版本号本身过滤稳定版，不能依据渠道名称判断。原生记录带 `runtime: 'native'`，宿主 Node 约束为 `node: '*'`；项目声明的 Node 条件和 infer 包本身的 Node 要求仍然有效。旧 Yarn 同版本优先采用 cli-dist、yarn、cli 的声明；只有官方 tag、注册表没有的版本，再查询该 tag 的包清单，缺失 engines 保持未知。常规列表排除预发布版；遇到允许预发布版的显式声明，按需补查元数据：精确版本查询该版本的官方清单或发布记录；范围查询对应官方版本列表，只保留符合范围的预发布版。Node 范围查询官方 dist、rc、nightly、v8-canary、test 索引。这些按需查询的记录不加入常规版本统计。返回每次查询的来源 URL、获取与验证时间、响应 SHA-256。具体链接见英文 README 和网站。

Node 包的本地缓存是本进程里的版本元数据缓存：使用 ETag/Last-Modified 条件请求，304 复用已解析数据，同时进行的请求合并。不会默认写磁盘，也不缓存目录扫描结果。刷新失败时可以使用旧的成功响应，但会警告并注明时间。没有官方数据时，只能基于已知运行环境候选推断，不能声称找到了全部已发布版本中的最大值。

随包发布的是编译后的锁兼容表。维护脚本把已经确认的行为变化边界生成 semver 范围；没有实测不兼容上界，就不加上界。旧包直接使用自己携带的范围判断新发布的包管理器版本；遇到表中没有的锁格式，约束为 `*`，保留包管理器类型。这是尽可能兼容的推断规则，不是对每个真实项目安装成功的保证。

仓库包含 23 份真实样本：npm package-lock 和 shrinkwrap 1/2/3；pnpm legacy shrinkwrap 3/4 及 lockfile 5/5.1/5.2/5.3/5.4/6/9；Yarn Classic v1 及 Modern 4/5/6/7/8/9/10。单个版本安装成功不能证明完整范围，未确认边界的格式按 `*` 处理。具体覆盖情况见保留的矩阵和边界报告。 [初始数据报告](maintenance/evidence/initial-release-data/README.md)列出精确版本清单、各包管理器的尝试与确定结果数量、未确定项和复现命令。

用 `pnpm data:seed --concurrency 6` 建立全量初始矩阵。首次运行将官方版本清单固定在 `maintenance/evidence/initial-matrix/catalog.json`；逐个测试所有 npm、pnpm、Yarn 发行版的稳定版（含历史 Yarn 发行渠道，不含预发布版）与该包管理器的每份样本。重复相同命令即可续跑；添加 `--retry-incomplete` 重试环境或工具准备失败的组合。每条记录、日志、旧工具安装依赖时生成的锁文件及 `summary.json` 都会保留。仅当输入和实验规则相同时复用成功记录；换一份版本清单应指定新的 `--output` 目录。npm 的 package-lock 与 shrinkwrap 使用独立的匹配条件。

历史 Yarn 独立脚本也从官方 tags 纳入清单。维护脚本将 tag 解析到 commit，下载该 commit 中的脚本，保存不可变 URL、文件大小和计算出的 SHA-512；这不是官方注册表发布的 SRI。执行文件必须自报所要求的版本。扩充清单时保留旧快照，仅当制品身份和样本字节不变时复用旧实验。[初始数据编译与成对复测](maintenance/compile-initial.md)说明了具体命令。

[当前稳定版报告](maintenance/evidence/stable-only/README.md)记录当前的 21 条编译规则、2 个未确定格式和 5 类活动 bug。更早的全版本报告保留为历史证据。

## API 与命令行

`infer` 完成读取、检测、获取数据和推断；`collect` 只读取声明；`resolve` 是无 I/O 的纯计算器，也可从 `node-toolchain-infer/resolve` 导入。`detectRuntime` 检测当前 Node、同安装目录的 npm 和可选的本地 pnpm/Yarn。`fetchCatalog`、`loadCatalog`、`loadRules` 分别获取官方数据、读取指定快照和兼容规则。`createSource` 与 `SOURCE_DEFINITIONS` 用于构造模拟输入。

可通过 `runtime`、`catalog`、`rules`、`fetcher`、`signal` 显式控制数据和取消操作。传入 `catalog` 后不再额外联网，快照缺少显式版本或范围所允许的预发布版本时也一样。结果包含最终版本、警告、逐条采纳过程、保留约束、候选版本、扫描目录和数据时间。

```sh
node-toolchain-infer --cwd . --node '18' --package-manager 'pnpm@^9' --json
```

## 开发与本地网站

仓库工具使用 Node 24 和 pnpm 10.33.0，发布产物支持 Node ≥18。

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm pack
pnpm website:build
pnpm website:serve
```

`website/` 是纯前端，含四个独立 tab 和中英切换，使用包本身的推断和官方数据解析逻辑。服务启动后打印本地 URL；可用 `PORT=49295` 指定端口。浏览器检查先执行 `pnpm exec playwright install chromium`，再执行 `pnpm website:test`；也可用 `CHROME_PATH` 指定已有的 Chrome。

`tsc` 使用 **TypeScript 7.0.2**。ESLint 的 `eslint-config-unicute` 通过微软官方的并行安装别名使用 TS 6 兼容 API；没有 `overrides`。统一通过 `pnpm lint:fix` 格式化。

维护脚本、定时 GitHub Action、原始证据、失败原因和 AI 维护步骤见 `maintenance/`。GitHub Actions 将后续维护证据保存在 `compatibility-data` 分支。每次推送到 `main` 会构建并部署中英文网站到 GitHub Pages。版本标签通过 `npm` Environment 和可信发布机制发布 npm 包，见[发布说明](docs/publishing.md)。

冻结安装按 pnpm 的待测版本选择参数：早于 `3.0.0-alpha.3` 用 `--frozen-shrinkwrap`，从该版本起用 `--frozen-lockfile`，适用于两种锁文件名。仅仅忽略了参数不能证明兼容，还必须通过矛盾清单对照。

Yarn 锁文件按内容区分 Classic、Berry YAML 和 Yarn 6 JSON。JSON 中的 `__metadata.version: 9` 不会匹配 Berry YAML 格式 9 的规则；没有稳定版实测规则的原生格式仍为 `*`，并返回警告。不能仅因 Yarn 改用原生程序就关闭已有 Berry 规则的开放上界。infer 只获取元数据，不下载安装包管理器。

维护测试使用官方 `@yarnpkg/yarn-<平台>` 制品，校验包名、精确版本、平台、SRI 和程序自报版本后直接运行；保留来源 URL、SRI 和二进制 SHA-256。平台没有对应制品时标记检查不完整，不当作锁格式不兼容。[Yarn 6 显式版本接入验证](maintenance/evidence/yarn6-integration/README.md) 的 RC 记录单独保存，不进入兼容矩阵、范围、版本统计或 knownBugs。

网站使用 `fetch` 的 `cache: no-cache`，由浏览器重新验证 HTTP 缓存，不手动添加会触发跨域预检的条件请求头。应用内版本数据只放内存，不向 localStorage 或 IndexedDB 写版本快照；浏览器 HTTP 缓存的存放方式由浏览器管理。
