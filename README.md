# tx-cli

基于 pnpm workspace 的 TypeScript monorepo，对外提供 `@tanyueran/cli` 命令行工具：创建项目、添加模块、与大模型对话（只读 `chat` / 可执行 `agent`），以及 `copy` / `server` / `git-rename` / `commit-fix` 等实用命令。

能力按「无头核心引擎 + 多端适配」组织：核心引擎不依赖终端与前端，CLI 层只负责命令注册、终端 REPL 与颜色渲染；同一套会话、工具与沙箱机制可复用于后续桌面端与云端服务。运行时要求 Node.js ≥ 22.12。

## 仓库结构

| 包 | 名称 | 说明 | 文档 |
|---|---|---|---|
| `packages/cli` | `@tanyueran/cli` | 对外发布包：命令注册与参数解析、终端 REPL、Channel 实现、CLI 专属服务（copy / server / commit-fix） | [README](packages/cli/README.md) |
| `packages/agent-core` | `@tanyueran/agent-core` | 无头核心引擎：会话编排、agentic loop、工具系统、沙箱与审批、LLM、MCP、技能 | [README](packages/agent-core/README.md) |
| `packages/agent-scaffold` | `@tanyueran/agent-scaffold` | `create` / `add` 共用的脚手架：模板发现、渲染与生成流程 | [README](packages/agent-scaffold/README.md) |
| `packages/agent-common` | `@tanyueran/agent-common` | 共享层：fs / paths / errors / 配置读写 / 串行队列 / 回合取消等通用能力 | [README](packages/agent-common/README.md) |

依赖方向自上而下，由 `pnpm deps:check` 强制（禁止循环依赖与跨包相对路径穿透）：

```text
cli ──> agent-core ──> agent-common
 │            ↑              ↑
 ├──> agent-scaffold ────────┘
 └───────────────────────────┘
```

## 快速开始

```bash
# 全局安装使用
npm install -g @tanyueran/cli

# 仓库开发
pnpm install
pnpm dev --help
```

命令用法（含 `chat` / `agent` 的选项与示例）见 [CLI 包说明](packages/cli/README.md)。

## 开发

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 以 tsx 直接运行 CLI |
| `pnpm build` | 构建 CLI 产物（rollup） |
| `pnpm test` / `pnpm test:coverage` | 全量单元测试 / 覆盖率（vitest） |
| `pnpm type-check` | 根工程 + 各子包类型检查 |
| `pnpm lint` | ESLint |
| `pnpm deps:check` | 包边界与循环依赖检查（dependency-cruiser） |
| `pnpm clean` | 清理各包构建产物 |
| `pnpm changelog` | 基于 conventional commits 生成 `CHANGELOG.md` |
| `pnpm publish:cli` | 交互式发布 `@tanyueran/cli`，并同步根包与各 workspace 包版本号 |

测试按包归位在 `packages/*/test/`；提交由 husky + commitlint 约束，lint-staged 自动修复暂存区 TS 文件。

## 文档

- [CLI 命令用法](packages/cli/README.md)
- [核心引擎与配置](packages/agent-core/README.md)
- [脚手架与模板](packages/agent-scaffold/README.md)
- [共享工具](packages/agent-common/README.md)
- [项目架构](docs/ARCHITECTURE.md)：对话链路、agentic loop、沙箱四层模型、扩展点
- [chat 命令详解](docs/CHAT.md) / [agent 命令详解](docs/AGENT.md)
- [开发笔记](docs/DESIGN-NOTES.md)
- [分阶段扩展方案](docs/expand/README.md)（历史方案快照）

## 路线图

- [x] 四包 monorepo 拆分与包边界收口
- [x] `chat` / `agent` 双模式（工具调用、思考档位、子 Agent、上下文压缩、用量统计）
- [x] 三档沙箱与审批策略、MCP 接入、技能系统
- [ ] 多模型 / 多 Provider 配置（Phase 4）
- [ ] Electron 桌面端（Phase 5）
- [ ] 云端 Agent 服务（Phase 6）
- [ ] REPL 正文 Markdown 渲染
