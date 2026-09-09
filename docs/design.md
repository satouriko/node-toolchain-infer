# toolchain-infer

独立 npm 包，JS ESM API + CLI。包的宿主 Node 要求为 >=20；待推断的项目 Node 可以是其他版本。项目外独立目录，不依赖 litest 或现有实验网站。npm 包名查询在 2026-09-09 返回 404，仅为可用性检查，不代表保留名称。

## 公共接口

`infer({cwd = process.cwd(), root, remoteContainer, runtime, catalog, rules})` 异步收集文件和当前工具版本，返回 `resolve({sources, runtime}, catalog, rules)` 的结果。

`collect({cwd, root, remoteContainer})` 返回 `{sources, warnings, directories, root}`。`resolve` 是纯函数，不读文件、不联网、不运行命令。返回 `{node, packageManager, warnings, trace, constraints}`；每个采用/忽略的声明都有来源、目录距离、归一化范围和原因。CLI 输出 JSON。

`Source`：`{id, kind, target:'node'|'manager'|'lock', value, manager?, format?, cacheKey?, features?, depth, rank, path, conditional?}`。冲突排序固定为 depth、rank、path、id；字段精确与否不改变优先级。

`runtime`：`{node, npm, pnpm?, yarn?, bun?}`。Node 来自当前进程；npm 从当前 Node 安装绑定的 npm manifest 探测，失败时用官方 Node 发行索引的绑定记录，再使用同 Node 执行 npm 探测并警告。不能硬编码版本。调用方可注入实际运行环境以测试或支持嵌入式运行时。

## 目录与优先级

从 cwd 的真实目录向上收集，默认止于最近包含 `.git` 文件或目录的目录（包含该层），无 git 时止于文件系统根目录（包含）；root 参数可以显式缩短到一个祖先目录。不会执行任何项目配置或脚本。

同目录：remote.container.node → remote.container.packageManager → package.json.packageManager → pnpm-lock.yaml → yarn.lock → npm-shrinkwrap.json → package-lock.json → bun.lock → bun.lockb → volta.node / volta 的对应包管理器 → .node-version → .nvmrc → .tool-versions → devEngines.runtime → devEngines.packageManager → engines.node → engines 对应包管理器。新增 Bun 文件放在已有 lockfile 优先顺序后，保持此前顺序。每一条有不同 rank；同文件数组按索引顺序，所有冲突警告并忽略后者，不抛版本冲突异常。

remoteContainer 由调用者传入，代表 cwd 的显式配置，避免独立库执行 litest 配置；版本仅允许数字和省略 minor/patch，不允许运算符或通配符。packageManager 的精确版本和完整性后缀分开解析；其他来源正常支持 semver 范围，.nvmrc 支持 node/stable/lts/*/lts/代号，无法确定的 alias 警告。

只用 engines.pnpm / engines.yarn / engines.bun 约束已经被选中的类型，不靠它们选择类型。未声明类型默认 npm。Bun 的安装工具与项目 Node 可以并存；Bun 的锁文件不产生 Node 要求。

## 选择

先把每一条包管理器声明或锁文件范围，与已发布包管理器候选各自的 engines.node 关联，再执行优先级合并。求可运行的 Node / 包管理器组合，不能把两边独立并集后丢失版本关联。高优先级条件接受后，冲突的低优先级条件及其推导条件一起丢弃。

Node 采用保留的精确值，否则当前 Node 满足时优先，否则从发行集合取最大满足版本。包管理器采用保留精确值，否则 npm 用选定 Node 绑定的 npm，pnpm/Yarn/Bun 用本地版本；候选不满足则取最大满足版本。已知稳定版本默认参与，显式预发行 semver 可以选择对应预发行；不能把 latest 标签当成最大满足版本。离线默认使用随包提供的有时间和来源的快照，可显式刷新。

## 自动下载数据

`data/catalog.json`：`{schemaVersion:1, generatedAt, sources:[{id,url,fetchedAt,sha256,etag?}], nodes:[{version,npm,lts,date}], managers:{npm:[],pnpm:[],yarn:[],bun:[]}}`；包管理器记录为 `{version,node:string|null,releasedAt?,sourceUrl?}`。node=null 表示未声明，不伪造成官方的 *；Bun 是独立运行时。无效已声明 engines 拒绝整次更新，保留旧文件。

锁文件兼容性不使用第三方版本映射。`data/compatibility.json`：`{schemaVersion:1, generatedAt, rules:[{id,manager,match:{format?,classic?,cacheKeyMin?,cacheKeyMax?,features?},range,provenance:{kind:'official-source'|'fixture-verified',url?,evidenceIds?}}], observations:[]}`。经审核的规则从真实冻结安装结果和官方读取器证据取得。精确测试版本集合可写成 OR 的精确 semver，未测试版本不自动加入；若使用连续范围，需要官方读取器覆盖证据，不能仅凭两个端点推断中间所有版本。

未覆盖格式仍提供包管理器类型证据，警告说明不能保证冻结安装兼容，不将未知当作通过。结果同时注明使用数据的时间和证据种类。

## AI 维护与实测

每种锁格式有独立 fixture 文件夹，包含真实依赖、manifest、生成工具版本、生成命令、锁文件与哈希。新版本运行冻结安装，前后对锁文件字节和 manifest 比较；退出码 0 且所有保护文件不变才 pass。版本不支持、安装失败、运行环境/网络失败、超时要区分；不得把环境失败归为格式不兼容。每个结果保存目标包管理器版本、实际 --version、Node、平台架构、fixture hash、命令、退出码、前后哈希、日志。

工具下载和 fixture 执行只在独立临时目录/项目缓存中，验证官方 tarball integrity，不全局安装、不写用户项目、不依赖本机已有包管理器。明确指定 Node binary 支持老版本和新版引擎要求。跨平台条件作为结果维度，不能用 macOS 单次结果断言全平台。

`releases:check` 比较当前发布列表和已记录的候选测试覆盖，输出需要维护的具体版本及可交给 AI 的任务。AI prompt 说明怎样查源码、添加/修复 fixture、生成和复查矩阵、更新有证据的规则、验证未知区间与错误分类，不以修改 expected 数据代替修复问题。样例测试文件夹由 AI 维护；无需 AI 的数据不交给 AI 手填。

## 验收

有纯函数约束测试（目录优先、精确/范围冲突、联动 Node engines、npm 绑定、Bun 并存）、真实文件收集测试、数据脚本原子失败测试、矩阵 runner 的 pass / 失败 / 锁文件改写 / 超时测试、四种包管理器真实冻结安装证据。所有 format fixture 的覆盖状态明确，未测试不算通过。最后安装 npm pack 产物验证 API、CLI、类型和随包数据。
