# tx-cli 扩展改造计划

> 将 tx-cli 从单体 CLI 工具改造为 pnpm + monorepo 架构，并扩展桌面端和云端服务能力。
>
> 当前进度：Phase 1、Phase 2、Phase 3 已完成；包职责与依赖边界已收口，下一步进行 Phase 4 多模型/多 Provider 配置，再继续多端扩展。
>
> 说明：本目录是分阶段改造的**历史方案快照**，其中出现的文件/目录路径反映当时的结构或后续阶段的规划（如 `packages/desktop`、`packages/server` 尚未创建），当前实际结构以 [ARCHITECTURE.md](../ARCHITECTURE.md) 为准。

## 改造目标

1. **Monorepo 化**：拆分为独立包，职责清晰，便于多端复用
2. **核心无头化**：core 不包含终端 REPL、ANSI 展示或前端适配代码，桌面端与云端可直接复用
3. **桌面端**：Electron 桌面应用，支持 Agent/Chat 切换、多模型切换
4. **云端服务**：在云服务器上运行 Agent 服务，通过浏览器访问，多用户支持

## 技术选型

| 项目 | 选型 | 说明 |
|---|---|---|
| 包管理 | pnpm + workspace | monorepo 依赖管理 |
| 语言 | TypeScript (ESM) | 与现有项目一致 |
| 桌面端框架 | Electron | 生态成熟，可直接复用 Node.js core 包 |
| 桌面前端 | React | 组件库丰富 |
| 云端后端 | Express + WebSocket | HTTP API + 实时通信 |
| 云端前端 | React | 与桌面端统一技术栈 |
| 认证 | JWT + bcrypt | 账号密码 + Token，仅服务端注册 |
| 沙箱 | 目录隔离 | 每用户独立 workspace 目录 |
| 状态管理 | zustand | 轻量 React 状态管理 |

## Monorepo 目标结构

```
tx-cli/
├── pnpm-workspace.yaml
├── package.json                  # 根 package（workspace 管理）
├── tsconfig.base.json            # 共享 TS 配置
│
├── packages/
│   ├── agent-common/             # @tanyueran/agent-common — 通用工具与配置读写
│   ├── agent-core/               # @tanyueran/agent-core — 无头核心引擎（Channel + 会话 + 工具）
│   ├── agent-scaffold/           # @tanyueran/agent-scaffold — 模板发现、渲染与生成流程
│   ├── cli/                      # @tanyueran/cli — 终端 REPL、命令适配与 CLI 专属服务（对外发布包）
│   ├── desktop/                  # @tanyueran/desktop — Electron 桌面应用（Phase 5 新增）
│   └── server/                   # @tanyueran/server — 云端 Agent 服务（Phase 6 新增）
│
├── packages/*/test/              # 各包单元测试
├── test/                         # 跨包与端到端集成测试
└── docs/
    └── expand/                   # 本目录
```

## 包依赖关系

```text
cli ─────────────> agent-core ─────────────> agent-common
 │                                             ↑
 ├──────────> agent-scaffold ──────────────────┘
 │                                             ↑
 └─────────────────────────────────────────────┘

desktop ──> agent-core ──> agent-common
server  ──> agent-core ──> agent-common
```

依赖约束：

- `shared` 不依赖任何 workspace 包。
- `core` 只依赖 `shared`，不得依赖 CLI、scaffold 或任何前端。
- `scaffold` 只依赖 `shared`，不再为了 Channel 类型依赖 core。
- `cli` 可以依赖 core、scaffold、shared，并独占终端 REPL 与 CLI 专属服务。
- `desktop/server` 只复用 core/shared，不得依赖 cli。

> 包命名：四个包统一使用 `@tanyueran/*` 前缀——`@tanyueran/cli` 对外发布，`@tanyueran/agent-common`（基础工具）、`@tanyueran/agent-core`（Agent 引擎）、`@tanyueran/agent-scaffold`（脚手架）为 private 内部包，构建时打进 CLI 产物。

## Phase 导航

| Phase | 标题 | 前置依赖 | 状态 | 文档 |
|---|---|---|---|---|
| 1 | pnpm + monorepo 拆分 | 无 | 已完成 | [phase-1-monorepo.md](./phase-1-monorepo.md) |
| 2 | core I/O 解耦 | Phase 1 | 已完成 | [phase-2-io-decoupling.md](./phase-2-io-decoupling.md) |
| 3 | 包职责与依赖边界收口 | Phase 2 | 已完成 | [phase-3-package-boundaries.md](./phase-3-package-boundaries.md) |
| 4 | 多模型/多 Provider 配置 | Phase 3 | 待开始 | [phase-4-multi-model.md](./phase-4-multi-model.md) |
| 5 | Electron 桌面端 | Phase 4 | 待开始 | [phase-5-desktop.md](./phase-5-desktop.md) |
| 6 | 云端 Agent 服务 | Phase 4 | 待开始 | [phase-6-cloud-server.md](./phase-6-cloud-server.md) |
| 7 | 打磨与发布 | Phase 5, 6 | 待开始 | [phase-7-polish.md](./phase-7-polish.md) |

## 实施原则

1. **每个 Phase 完成后 CLI 功能必须不变** — 所有现有测试必须通过
2. **先完成边界收口** — Phase 3 未验收前，不开始多模型、桌面端和云端改造
3. **按 Phase 顺序执行** — Phase 5 和 Phase 6 可以在 Phase 4 完成后并行
4. **每个 Task 完成后验证** — 按验收标准逐项检查
5. **最小改动原则** — 不做与当前 Task 无关的改动，不为每个小能力新增 package
