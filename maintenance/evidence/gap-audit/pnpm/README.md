# pnpm 全部断点核查

核查对象是 `compatibility-policy-update/report.json` 的全部 pnpm 点位。`../inventory-before.json` 保存修改前清单：稳定版本支持区间中的每个缺口、每个有结果变化的预发布分组、实际 semver 匹配结果及原始记录 ID。下面区分真正的格式边界、已确认的安装 bug、测试配置错误和未能运行的发行包。

## pnpm 9.1.0–9.4.0

lockfile 9 的原范围以 `>=9.0.0-rc.0` 开头。这已经包含 9.1.0、9.2.0、9.3.0、9.4.0 及它们之间的稳定补丁版本，原实测也全部支持。后面的 `|| >=9.1.0-0 <9.1.0` 是补充预发布版本，不是给前一段增加上界。这里不存在稳定版本断点。

## pnpm 5.17.0

影响 lockfile 5、5.1、5.2、5.3、5.4。原冻结安装返回 0，锁文件字节不变，但未创建 `node_modules/is-number`；日志停在下载完成、尚未导入包的位置。

- 原发行包在 Node 24.10.0 和同时代 Node 15.8.0 上均复现，不能归因于仅使用了过新的 Node。
- 只将包导入方式改为 `copy`，同一原始可执行文件在全部五份原始锁文件上安装正确，所有被监测文件字节不变。`hardlink` 也通过；5.17.1 默认模式通过。
- [5.17.0 官方读取器](https://github.com/pnpm/pnpm/blob/v5.17.0/packages/lockfile-file/src/read.ts) 按 `Math.floor(lockfileVersion)` 检查格式，明确接受这些 5.x 格式。对照实验将问题定位到 auto/clone 文件导入方式，但没有查明更底层的原因。
- [5.17.0 到 5.17.1 的官方差异](https://github.com/pnpm/pnpm/compare/v5.17.0...v5.17.1) 涉及 graceful-fs 的打包方式。但单独补装 graceful-fs 未修复复现，因此没有将“缺少 graceful-fs”冒充已证实的根因，也没有将修改后的可执行文件作为发行版本实测。

上游 issue 状态：**本地已复现，尚未确认对应的上游 issue**。2020 年的 [pnpm #2879](https://github.com/pnpm/pnpm/issues/2879) 报告 macOS 上 pnpm 5.5.13 的 clone 失败而 copy/hardlink 成功，属于相似现象；版本不同且没有同源证据，不能把它直接登记为 5.17.0 的根因。[5.17.1 发布说明](https://github.com/pnpm/pnpm/releases/tag/v5.17.1) 也没有指出这个问题或修复 issue。这里的 compare 链接只提供源码变更，不代表官方确认。检索结果保存在 `upstream-issue-search.json`；没有查到精确对应项，不等于无人报告，也不构成首次发现的证明。

处理：精确审核原 `semantic-mismatch` 记录，保留其失败事实；语义兼容恢复并附 `pnpm-auto-import-5.17.0` 标记。独立证据位于 `proofs/5.17.0-node-15.8.0-pnpm-lock-v5.4/`，包含五个 copy 对照、hardlink 对照和原始默认模式；未成功的修补实验也保留。

## pnpm 7.33

lockfile 6 样例记录 `settings.autoInstallPeers=true`，而 pnpm 7 默认是 false。[7.33.0 新增设置一致性检查](https://github.com/pnpm/pnpm/pull/6557)，原测试因此收到 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`。这是测试没有复现锁文件生成配置，不是该版本无法解析格式 6。

修正维护测试：只从锁文件读取白名单内的布尔设置 `autoInstallPeers`、`excludeLinksFromLockfile`，设置测试环境并在 Observation、日志和指纹中保留；矛盾清单对照使用同样设置。没有修改输入文件或包管理器代码。7.33.0–7.33.7 八个发行版全部重新安装，字节不变、依赖正确、矛盾清单被拒绝。

处理：原错误配置记录逐条以原 row SHA-256 登记为 evidence exclusion；新记录取代其作为格式判断的依据。没有将测试程序错误登记为 pnpm 上游 bug。不同显式测试配置不能用于证明相邻版本边界。

## pnpm 8 prereleases

8.0.0-alpha.0、beta.0、beta.1 对 lockfile 6 都会重写 YAML；Node 19.7.0 逐个复现后，解析得到的完整对象相同、安装依赖相同，而且修改后的 SHA-256 与历史失败一致。rc.0 不再改写。[官方冻结重写修复 #6260](https://github.com/pnpm/pnpm/pull/6260) 对应这类无须保存却重新序列化的行为。

处理：这三个预发布版本恢复语义兼容，保留 `pnpm-frozen-rewrite-8-prerelease` 标记。pnpm 8 对 lockfile 5.x 的明确拒绝仍保留，不能把一个格式的例外套用到其他格式。

## pnpm 9.0

9.0.0-rc.0、rc.1、rc.2、9.0.0：读取器的 `wantedVersions` 明确包含 `LOCKFILE_VERSION_V6`，但 frozen 的 full-resolution 判断错误地拒绝旧格式。[官方 bug #7934](https://github.com/pnpm/pnpm/issues/7934)、[修复 #7935](https://github.com/pnpm/pnpm/pull/7935) 和 9.0.1 发布记录吻合。四个版本在 Node 20.12.2 逐个复现；修复后的相邻版本已有相同锁文件通过证据。

处理：精确审核这四个版本的对应拒绝记录，恢复语义兼容并警告。

9.0.0-alpha.5 到 beta.3 则不同：官方 `readLockfiles.ts` 的 `wantedVersions` 只有当时的新格式，没有 v6。这里是明确的接受格式变化，保留不兼容结果。不能因为后来的 rc 恢复支持，就自动删除中间所有拒绝点。

## pnpm 9.0.5

同一份 lockfile 6 在冻结安装中被升级为 9，依赖 `is-number@7.0.0`、specifier、integrity、engines 和依赖图保持一致。修改后的文件哈希与每条被审核的历史失败相同。[官方 bug #7991](https://github.com/pnpm/pnpm/issues/7991) 在 9.0.6 修复。

处理：该版本恢复 lockfile 6 的语义兼容，附 `pnpm-v6-frozen-upgrade-7991` 标记。原记录仍为 rewrite，不能声称原命令没有修改锁文件。

## 其他稳定版本和预发布空白

旧 `shrinkwrap.yaml` v3 的 2.0.0-rc.0、2.12.0-0/1、2.14.0-0/1、2.17.0-0/1/2/3/4/5 共 11 个预发布版也全部补测。原记录有旧 graceful-fs 与新 Node 冲突，或分类器未识别 `Cannot run headless installation because shrinkwrap.yaml is not up-to-date with package.json`，虽已正确拒绝矛盾清单仍被记为 unknown。使用 Node 10.24.1 和当前分类器，11 个版本均安装正确、输入字节不变且冻结对照被接受。新增的是完整真实记录，未修改旧状态。

旧 shared-workspace v4 样例的 pnpm 12 alpha unknown 则来自 `ERR_PNPM_WORKSPACE_WALK_ERROR`：早期 Rust walker 将 `packages/*` 没有对应目录视为启动失败。它没有证明格式兼容或不兼容，且位于 v4 已确认的范围上界之外；没有用这个错误制造新断点。

| 版本 | 核查结果 | 对推断范围的影响 |
| --- | --- | --- |
| 3.5.4 | 官方 npm tarball 返回 404；没有可核验的执行制品 | 原有 5.x 范围已包含它；保留未知实测状态 |
| 3.7.2 | 原 CLI 的报错器初始化前失败；诊断捕获 `Cannot find module '@zkochan/rimraf'` | 发布包启动问题，不产生格式上界 |
| 4.2.0 | 启动加载 `@pnpm/list/lib/renderTree.js` 时读取 `undefined.yellow`；在 Node 12.13.0 复现 | 发布包启动问题，不产生格式上界 |
| 4.2.1 | 同一模块带有 `!((_a = pkg.dependencies), === null ...)` 非法 JavaScript；在 Node 12.13.0 复现 | 发布包语法错误，不产生格式上界 |
| 4.12.3 | 原准备流程错误解析工具开发依赖；修正后仍不能取得有效自报版本 | 保留未知，不据此宣称不兼容 |
| 5.4.1 | 原发行代码缺少 `delay` 模块 | 保留未知；现有稳定范围不排除它 |
| 5.9.1 | 原记录缺少 `@pnpm/cli-meta`；修正依赖准备后仍不能取得有效自报版本 | 保留未知；现有稳定范围不排除它 |
| 7.32.1、8.3.0 | Node 20+ 下旧 node-fetch 触发 `ERR_INVALID_THIS`；Node 18.16.0 下 7.32.1 全部六份适用样例、8.3.0 的 v6 样例通过 | 新增真实成功记录；没有用运行环境错误生成范围断点 |
| 4.5.0-1、4.7.0-0、4.9.0-1、4.14.0-1 | 历史未完成记录涉及开发依赖准备、缺失模块或工具自报版本失败；补测与错误收据保存在 proofs 中 | 不登记为格式不兼容 |
| 0.0.0-pr4475.1、0.0.0-pr4475.2 | 发行制品的实际版本与标签不符 | 不将其他版本的执行结果冒充这个版本 |
| 12.0.0-alpha.0–alpha.13 | 原正常安装已成功，但 Rust `pacquet_package_manager::outdated_lockfile` 被测试程序漏判，矛盾清单对照误记 unknown | 修正识别并逐个重跑，使用新的控制实验结果 |

`startup-diagnostic.json` 通过临时 preload 显示 CLI 原错误处理器吞掉的错误；它只用于定位启动原因，不作为成功安装记录。原始发行文件没有被修改。

## 保留的其他真实边界

旧 `shrinkwrap.yaml` 与 `pnpm-lock.yaml` 的命名切换、lockfile 5 在 pnpm 8 的拒绝、lockfile 6 在 pnpm 10 rc/稳定版的拒绝、lockfile 9 在 pnpm 9 rc 以前的拒绝均在原逐版本记录中明确出现。新代码不会自动填平这些边界。原先已审核的 pnpm 7.28.0–7.30.0 冻结重写例外继续保留。

## 复现与记录

`rows/`、`logs/` 是可直接传给 `data:compile --evidence maintenance/evidence/gap-audit/pnpm` 的追加记录，`catalog.json` 保留原官方目录。`proofs/` 包含隔离运行的工具身份、前后文件、原命令、配置对照和结果。`candidate-known-bugs.json` 逐条绑定观察指纹。`exclusions.json` 仅适用于本目录自己的被审核错误配置记录；其他目录的排除记录保存在各自目录中。

本目录保存原始失败和成功，不能把“语义兼容”计作“原冻结测试通过”。全量核查结论及更新后的数字见上一级报告。

最终范围表示遵循用户确认的规则：稳定版单独编译为范围，预发布按主/次/补丁号合并兼容范围，各组单独列出并保留独立上界。上文旧范围仅用于解释核查前的现象；最终表达式以 compiled 报告为准。
