# 兼容判定与发行数据更新

在原始全版本实测记录上重新编译，未修改任何历史 row 或安装日志。

- 44 条已审核的 pnpm #6158 失败记录覆盖 40 个组合（10 个精确版本 × 4 种锁格式）；原始状态仍为 rewrite，语义兼容判为 supported。
- 范围不再排除这处 bug 影响的版本。支持 4,809 个组合，不支持 11,096 个，未知 2,276 个；总数仍为 18,181。
- 19 条兼容规则保留普通 semver 的预发布匹配语义，连续兼容预发布段合并，未覆盖任何实测拒绝点。
- npm 发行数据不包含完整 provenance 或证据 ID 列表，只含规则及必要的已知 bug 标记。
- 原始严格冻结判定报告保留在 [initial-release-data](../initial-release-data/README.md)；原失败结果与新兼容判定见 [summary.json](summary.json)。

[新兼容表](compatibility.json) · [完整编译报告](report.json) · [bug 审核记录](../../known-bugs.json) · [独立复现证据](../known-bugs/pnpm-6158/README.md)

编译仍返回 2：原有 2,276 个未知组合未被本次修改掩盖，未知格式继续按 * 推断。独立复现的四份 lockfile 在 YAML 解析后完全相同且依赖安装正确；四份生成的前后文件 SHA-256 与审核过的历史重写一致。

[交付验证](verification/index.json)：160 项测试通过；lint、typecheck、构建及中英文浏览器检查通过。最终 npm 安装包在 Node 18.20.8 与 24.10.0 验证，并确认与测试安装目录的 53 个文件逐字节一致。
