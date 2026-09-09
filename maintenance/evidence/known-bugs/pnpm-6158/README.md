# pnpm #6158 的语义兼容复核

已知上游 bug 会在冻结安装时重新序列化没有变化的锁文件。官方 [issue #6158](https://github.com/pnpm/pnpm/issues/6158)、[修复 #6260](https://github.com/pnpm/pnpm/pull/6260) 和 [7.30.1 更新日志](https://github.com/pnpm/pnpm/releases/tag/v7.30.1) 解释了原因与修复。

本目录使用官方 pnpm 7.28.0、官方 Node 19.7.0 / macOS arm64 独立复现。每个子目录保留 before.yaml、after.yaml、proof.json；proof 的 observation 包含实际工具、命令、完整输入与输出摘要、依赖验证和日志路径。

- pnpm-lock-v5
- pnpm-lock-v5.1
- pnpm-lock-v5.2
- pnpm-lock-v6

四份命令均退出 0 且安装 is-number@7.0.0；只改变 pnpm-lock.yaml 的序列化。对前后 YAML 完整解析并按对象语义比较，结果完全相同，包括锁格式和依赖图。登记的 44 条历史记录均满足相同输入摘要和相同输出摘要，覆盖 >=7.28.0-0 <7.30.1 的 10 个精确发行版本及这四份样例。记录 ID 与 portable fingerprint 绑定在 ../../../known-bugs.json；未标记同版本的其他失败。

这是一项兼容判定例外，原始 rewrite 不是测试程序误判，不使用 exclusions，也不改成测试 pass。未来其他已知 bug 可以用独立读取器/生成器或复现证据证明语义支持，不限于此处的格式重写。
