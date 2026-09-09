// Dynamic messages use explicit templates; no remote translation or invented facts.
export const englishPatterns: Array<[RegExp, string | ((...groups: string[]) => string)]> = [
  [/^已获取 (\d+) 个版本$/, '$1 versions fetched'],
  [/^获取时间：(.*)$/, 'Fetched: $1'],
  [/^(\d+) 个来源失败，停止输出最终版本$/, '$1 source(s) failed; no final version returned'],
  [/^读取官方数据 (\d+) \/ (\d+)$/, 'Fetching official data $1 / $2'],
  [/^(.*) 个稳定版本$/, '$1 stable versions'],
  [/^(.*) 个已发布版本$/, '$1 published versions'],
  [/^最近获取 (.*)$/, 'Last fetched $1'],
  [/^(npm|pnpm|yarn) 版本$/, '$1 version'],
  [/^共 (\d+) 条 · 第 (\d+) \/ (\d+) 页$/, '$1 records · Page $2 / $3'],
  [/^第 (\d+) 条重复声明的来源$/, 'Source for additional declaration $1'],
  [/^第 (\d+) 条声明的目录层数$/, 'Directory depth for declaration $1'],
  [/^第 (\d+) 条声明值$/, 'Value for declaration $1'],
  [/^第 (\d+) 条声明的 yarn\.lock 文件族$/, 'yarn.lock family for declaration $1'],
  [/^删除第 (\d+) 条声明$/, 'Remove declaration $1'],
  [
    /^加入后剩余：(\d+) 个 Node(?: \/ (\d+) 个包管理器版本)?$/,
    (_, node, pm) => `Remaining after merge: ${node} Node${pm ? ` / ${pm} manager versions` : ''}`,
  ],
  [/^(\d+) 个具体候选分别携带相同的条件$/, '$1 concrete candidates share this condition'],
  [/版本索引 (.*?) 与 manifest.version 不一致/g, 'Version index $1 differs from manifest.version'],
  [/版本数据中找不到 (.*?) 对应的 LTS。/g, 'No LTS release matches $1 in version data.'],
  [
    /版本数据未收录 Node (.*?) 绑定的 npm，无法确定兜底组合。请从已收录的 Node 版本中选择。/g,
    'Version data lacks bundled npm for Node $1. Select a recorded Node release to determine the fallback pair.',
  ],
  [
    /在 gitRoot（第 (\d+) 层）停止向上查找；第 (\d+) 层不在收集范围内。/g,
    'Search stops at gitRoot (depth $1); depth $2 is outside the collection boundary.',
  ],
  [
    /当前类型为 (.*?)；此字段只约束 (.*?)，不参与类型选择。/g,
    'Selected manager is $1; this field constrains only $2 and does not select identity.',
  ],
  [
    /已核对版本中没有默认生成锁格式 (.*?) 的 (.*?)；本条与更高优先级条件无法同时满足。/g,
    'No checked $2 version generates lock format $1; this source conflicts with higher-priority constraints.',
  ],
  [
    /版本数据中没有满足 (.*?) 的可运行候选；已忽略此条件。请检查输入或重新获取版本数据。/g,
    'Version data has no runnable candidate satisfying $1; this condition was ignored. Check inputs or refresh metadata.',
  ],
  [
    /(.*?) 与已保留的 (.*?) 类型冲突；忽略本条声明。/g,
    '$1 conflicts with retained manager $2; ignore this declaration.',
  ],
  [
    /尚无锁格式 (.*?) 的冻结安装实测数据。本次只保留 (.*?) 类型，未施加锁兼容版本限制；显示的是候选，不能保证冻结安装成功。/g,
    'No frozen-install evidence for lock format $1. Retain $2 identity without a lock compatibility version restriction. This candidate does not guarantee frozen-install success.',
  ],
  [
    /(npm|pnpm|yarn) 类型；锁格式 (.*?) 的兼容性未验证/g,
    '$1 identity; compatibility with lock format $2 is unverified',
  ],
  [/（上级 (\d+) 层）/g, ' (parent depth $1)'],
  [/默认锁格式 = (.*)/g, 'Default lock format = $1'],
  [/默认锁格式 (.*?)（逐版本核对）/g, 'Default lock format $1 (checked per version)'],
]
