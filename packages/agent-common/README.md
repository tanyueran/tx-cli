# @tanyueran/agent-common

tx-cli monorepo 的共享层（private 包），为 `agent-core`、`agent-scaffold` 与 `cli` 提供与业务无关的通用能力。

- 不依赖任何其他 workspace 包，也不含终端渲染与前端适配；
- 以源码形式被其他包直接引用（`main` / `types` / `exports` → `src/index.ts`），构建 CLI 时由 rollup 一并打包；
- 只放跨包复用的纯工具与基础设施，不放业务逻辑。

## 模块一览

| 模块 | 主要导出 | 说明 |
|---|---|---|
| `fs` | `readTextFile`、`sliceLines`、`walkDir`、`existsWithExactCase`、`isExecutable`、`MAX_TEXT_FILE_BYTES`、`DEFAULT_IGNORED_DIRS` | 文本文件读取（1MB 上限）、按行切片（支持 `offset` / `limit`）、目录遍历（默认跳过 `node_modules` / `.git`）、大小写精确校验 |
| `paths` | `findNearestDirUp`、`findPackageRoot`、`getVersion`、`resolveFromCwd`、`expandHome`、`isPathWithin` | 向上查找目录与包根、读取包版本号、`~` 展开、路径包含判断 |
| `errors` | `CliError`、`CancelError` | 统一的业务错误与取消错误（`CancelError` 用于回合取消传播） |
| `config-merge` | `mergeStringArrays`、`mergeRecords` | 配置分层合并：字符串数组取并集，对象按字段由高优先级覆盖 |
| `user-config` | `resolveGlobalConfigPath`、`resolveProjectConfigPath`、`readGlobalConfig`、`updateConfigSection` | `~/.tx-cli/config.json` 与 `<cwd>/.tx-cli/config.json` 的路径解析、带缓存的读取、按段更新 |
| `text` | `globToRegExp`、`findTextMatches` | glob 转正则、文本检索（返回行号与匹配内容） |
| `string` | `toPascalCase`、`stripAnsi`、`displayWidth`、`padToWidth`、`truncateToWidth`、`isStringArray` | 命名转换与终端显示宽度计算（兼容中文全角），供脚手架命名与用量表格对齐复用 |
| `timeout` | `withTimeout`、`withPausableTimeout`、`pauseToolTimeout`、`resumeToolTimeout` | 超时控制；工具审批问询期间可暂停计时，避免用户思考时间计入超时 |
| `serial-queue` | `SerialQueue` | 会话级串行执行队列：任务按提交顺序执行，前序失败不阻断后续 |
| `turn-cancel` | `runWithTurnCancellation`、`markTurnCancelled`、`throwIfTurnCancelled`、`runDetachedFromTurnCancellation`、`runInBackgroundScope`、`isInBackgroundScope` | 基于 `AsyncLocalStorage` 的回合级取消标记与后台任务作用域 |

## 使用示例

```ts
import path from "node:path";
import {
  SerialQueue,
  globToRegExp,
  readTextFile,
  sliceLines,
} from "@tanyueran/agent-common";

// 串行执行写侧操作，避免并发读改写竞态
const queue = new SerialQueue();
await queue.run(async () => {
  // ... 判定、审批、写入
});

// 读取文本文件（绝对路径，超过 1MB 抛错），按行切片便于分段阅读
const content = await readTextFile(path.resolve("src/index.ts"));
const { text, totalLines } = sliceLines(content, 1, 50);

const pattern = globToRegExp("**/*.ts");
if (pattern.test("src/index.ts")) {
  // ...
}
```

配置文件读取带进程内缓存，只负责 IO 与 JSON 解析；各段（`llm`、`sandbox`、`mcpServers` 等）的校验由 `agent-core` 对应模块完成。

## 依赖约束

- 禁止在此包中引入 `@tanyueran/agent-core`、`@tanyueran/agent-scaffold`、`@tanyueran/cli`；
- 保持零业务依赖：新能力若只被单个包使用，应放在该包内，而不是提升到这里。

## 开发

```bash
pnpm --filter @tanyueran/agent-common type-check
pnpm --filter @tanyueran/agent-common build
```
