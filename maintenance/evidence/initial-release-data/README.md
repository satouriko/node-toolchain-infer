# 初始全版本实测数据

> 后续兼容判定已更新：已确认的上游 bug 单独标记，预发布范围合并，发行包去掉完整 provenance。当前数据见 [兼容判定更新](../compatibility-policy-update/README.md)。本页保留最初严格冻结测试的统计与范围。

本次固定官方目录包含 **2,259 个精确发行版本**（含预发布），对应 **23 份样例、18,181 个组合**。每个组合都有尝试记录；其中 **15,905 个有确定结果，2,276 个无法判定**，不存在尚未安排尝试的组合。

“尝试”包括下载、准备或启动失败；不能把这些记录说成成功执行了安装命令。确定结果中也包含明确不兼容，而不只是安装通过。

| 包管理器 | 精确发行版本 | 样例 | 组合 / 有尝试记录 | 支持 | 明确不支持 | 无法判定 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| npm | 605 | 6 | 3,630 / 3,630 | 1,171 | 1,883 | 576 |
| pnpm | 1,319 | 9 | 11,871 / 11,871 | 3,369 | 7,150 | 1,352 |
| yarn | 335 | 8 | 2,680 / 2,680 | 229 | 2,103 | 348 |
| 合计 | 2,259 | 23 | 18,181 / 18,181 | 4,769 | 11,136 | 2,276 |

目录语义摘要：`c6534790485cbc5dfaa6e716267fb590ab2bc91734b116361a532536e454fdac`。原始清单位于 [yarn-pnp-matrix/catalog.json](../yarn-pnp-matrix/catalog.json)；旧目录的原快照也完整保留。获取时间、官方 URL、响应哈希、每个发行版的源包与 Node 要求都在清单里；不把今天的可变最新列表冒充实验当时的输入。

[机器可读汇总](coverage.json) · [完整逐版本报告](report.json) · [完整文字报告](report.md) · [编译出的兼容表](compatibility.json) · [交付验证记录](verification/index.json)

## 如何判定

- 支持：实际冻结命令成功，所有监测的输入和锁文件字节不变，安装得到原锁定依赖，并通过矛盾清单对照。对照必须拒绝新的不一致清单，或继续安装原锁定版本且不修改文件。
- 明确不支持：有效命令明确拒绝该冻结安装，或成功退出但改写了监测文件、装错或漏装依赖。这是当前样例与冻结安装约定下的结果。
- 无法判定：工具制品缺失、自报版本不符、依赖准备失败、旧 Node/工具运行异常、网络或校验错误、控制实验未能证明锁文件生效，以及不满足当前证据约定的记录。失败日志保留，不拿这些失败推断不兼容上界。

每个包管理器测试其自身全部样例。npm 的 package-lock 与 shrinkwrap 分开；pnpm 旧 shrinkwrap 与新 lockfile 分开；Yarn Classic 与 Modern 分开。每份当前样例的生成基线和矛盾清单对照均通过。样例使用真实 `is-number@7.0.0`，矛盾清单请求 `6.0.0`。这不覆盖所有 workspace、peer、patch、平台或项目配置组合。

主机为 macOS arm64。记录同时包含实际 Node 的 arm64/x64 架构；历史 x64 Node 使用官方发行包经 Rosetta 执行。Linux/Windows 并未在本次本地数据中实测。历史工具需补装运行依赖时，保留独立的依赖锁、命令和哈希，不能把补装后的工具说成未处理的原始 tarball。

## 当前随包规则

共编译出 **19 条范围**，其余 **4 种格式保持未知**。表格为稳定版本部分；确实通过实测的预发布版本以精确 OR 条件另存于兼容表。没有用“最新实测版本”制造上界，也没有按主版本号猜变化点。

| 包管理器 / 锁文件 / 格式 | 编译出的稳定版本范围 | 另有实测通过的预发布版本数 |
| --- | --- | ---: |
| npm / package-lock.json / 3 | 未确认 → `*` | — |
| npm / npm-shrinkwrap.json / 3 | 未确认 → `*` | — |
| pnpm / pnpm-lock.yaml / 9.0 | `>=9.0.0` | 88 |
| yarn / yarn.lock / 1 | 未确认 → `*` | — |
| yarn / yarn.lock / 8 | `>=4.1.0 <4.14.0` | 3 |
| npm / package-lock.json / 1 | `>=5.7.0` | 46 |
| npm / package-lock.json / 2 | `>=5.7.0` | 46 |
| pnpm / pnpm-lock.yaml / 5.4 | `>=3.0.0 <5.17.0 || >=5.17.1 <8.0.0` | 174 |
| pnpm / pnpm-lock.yaml / 6.0 | `>=7.24.0 <7.28.0 || >=7.30.1 <7.33.0 || >=8.0.0 <9.0.0 || >=9.0.1 <9.0.5 || >=9.0.6 <10.0.0` | 29 |
| npm / npm-shrinkwrap.json / 2 | `>=5.7.0 <12.0.0` | 42 |
| npm / npm-shrinkwrap.json / 1 | `>=5.7.0 <12.0.0` | 42 |
| pnpm / pnpm-lock.yaml / 5.1 | `>=3.0.0 <5.17.0 || >=5.17.1 <7.28.0 || >=7.30.1 <8.0.0` | 170 |
| pnpm / pnpm-lock.yaml / 5 | `>=3.0.0 <5.17.0 || >=5.17.1 <7.28.0 || >=7.30.1 <8.0.0` | 170 |
| pnpm / pnpm-lock.yaml / 5.2 | `>=3.0.0 <5.17.0 || >=5.17.1 <7.28.0 || >=7.30.1 <8.0.0` | 170 |
| pnpm / pnpm-lock.yaml / 5.3 | `>=3.0.0 <5.17.0 || >=5.17.1 <8.0.0` | 174 |
| yarn / yarn.lock / 4 | `>=2.3.0 <3.0.0` | 0 |
| yarn / yarn.lock / 10 | `>=4.15.0` | 0 |
| yarn / yarn.lock / 6 | `>=3.2.0 <4.0.0` | 8 |
| yarn / yarn.lock / 9 | `>=4.14.0 <4.15.0` | 0 |
| yarn / yarn.lock / 5 | `>=3.1.0 <3.2.0` | 12 |
| yarn / yarn.lock / 7 | 未确认 → `*` | — |
| pnpm / shrinkwrap.yaml / 3 | `>=1.41.1 <3.0.0` | 6 |
| pnpm / shrinkwrap.yaml / 4 | `>=2.17.2 <3.0.0` | 6 |

未确认范围的具体原因：

- npm package-lock v3、shrinkwrap v3：npm 7 至 8.4.0 附近的对照实验会安装清单中新要求的版本，不能证明原锁文件在生效。8.4.1 的有效成功点不能独自证明整个区间的下界。使用 Node 16.10.0 复测 8.4.0 相邻点后仍有此缺口。编译报告保留 174 个相邻复测任务，而不是伪造范围。
- Yarn Classic v1：早期版本无法建立可信的支持下界。
- Yarn Modern v7：已有通过的预发布版本证据，但没有建立稳定版本的支持区间。

这些格式在本包中按 `*` 推断并警告，原始支持/拒绝证据仍保留在完整报告中；`*` 不意味着实测支持所有版本。未知未来锁格式采用同样的宽松规则。

## 证据保留与修正

所有重试追加新记录。实验规则更正后的旧记录不被改写：49 条已确认存在测试程序误判的 Yarn 记录由绑定原始字节 SHA-256 的 exclusions 明确排除；旧协议、旧冻结参数、缺少有效对照的记录由验证器标记为历史或无效依据。两份 npm v2 样例改用 npm 8.19.4 作为生成基线，实测生成的输入与原样例逐字节一致，原生成收据另行归档。

pnpm 历史冻结选项、shared-workspace 生成选项、旧版明确拒绝提示和 store 配置均按实际官方源码与命令行为核实。缓存隔离修正后续跑前，44,918 条既有 seed JSON 逐条验证可解析；原始记录未修改。72 组旧 pnpm 相邻版本对已在同一 Node 10.24.1 环境完成补测。

- [完整初始矩阵](../initial-matrix/)
- [最初成对边界](../initial-boundaries/)
- [Yarn 历史发行渠道补充](../yarn-supplement/) 与 [PnP 矩阵](../yarn-pnp-matrix/)
- [Yarn 成对边界](../yarn-boundaries/)
- [旧 pnpm 成对复测](../legacy-pnpm-boundaries/)
- [npm v3 控制实验复测](../npm-v3-controls/)
- [Yarn 官方制品来源](../yarn-distributions/)
- [pnpm 历史冻结命令](../pnpm-frozen-command-history/)、[共享工作区生成](../pnpm-shared-generation/)、[store 隔离](../pnpm-store-isolation/)

原始目录不随 npm 包发布。包只包含编译规则与证据 ID，运行推断时不下载包管理器，也不执行这些实验。

## 重新编译与维护

```sh
pnpm data:compile \
  --catalog maintenance/evidence/yarn-pnp-matrix/catalog.json \
  --recipes fixtures/recipes.json --fixtures-root fixtures \
  --evidence maintenance/evidence/initial-matrix \
  --evidence maintenance/evidence/initial-boundaries \
  --evidence maintenance/evidence/yarn-supplement \
  --evidence maintenance/evidence/yarn-pnp-matrix \
  --evidence maintenance/evidence/yarn-boundaries \
  --evidence maintenance/evidence/legacy-pnpm-boundaries \
  --evidence maintenance/evidence/npm-v3-controls \
  --output .cache/recompiled-initial-data
```

本快照的编译退出码为 **2（证据仍有未确定项）**。三个输出文件仍完整生成；不能为了绿灯删除未确定记录。复现矩阵和成对重测参见 [编译方法](../../compile-initial.md)，新版本维护使用 [人和 AI 共用的说明](../../update-compatibility.prompt.md)。已验证的旧字节与记录复用；新格式、行为变化或无法解释的失败交由维护流程处理。

## English summary

The fixed official catalog contains 2,259 exact releases including prereleases. All 18,181 manager/fixture combinations have attempt records: 15,905 conclusive and 2,276 unknown. An attempt may fail during provisioning or startup and does not assert that an installer ran successfully. The compiler emits 19 rules; four unconfirmed formats remain permissive `*` with warnings.

See `coverage.json` for definitions and per-manager counts, `report.json` for every version and evidence identity, and `compatibility.json` for stable intervals plus exact measured prereleases. Boundaries use adjacent official stable releases tested with the same fixture and verified Node/platform identity. Original attempts, incompatible results, inconclusive failures, source receipts and reviewed exclusions are preserved. Unknowns keep compilation at exit code 2; they are not silently converted into incompatibility or successful coverage. This local baseline covers macOS arm64 with official historical x64 Node distributions, not every operating system or dependency graph.
