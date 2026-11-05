# tx-cli 扩展改造计划

> 将 tx-cli 从单体 CLI 工具改造为 pnpm + monorepo 架构，并扩展桌面端和云端服务能力。

## 改造目标

1. **Monorepo 化**：拆分为独立包，职责清晰，便于多端复用
2. **桌面端**：Electron 桌面应用，支持 Agent/Chat 切换、多模型切换
3. **云端服务**：在云服务器上运行 Agent 服务，通过浏览器访问，多用户支持

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
│   ├── shared/                   # @tx-cli/shared — 纯工具函数
│   ├── core/                     # @tx-cli/core — 核心引擎（I/O 解耦）
│   ├── scaffold/                 # @tx-cli/scaffold — 项目脚手架
│   ├── cli/                      # @tx-cli/cli — CLI 入口
│   ├── desktop/                  # @tx-cli/desktop — Electron 桌面应用
│   └── server/                   # @tx-cli/server — 云端 Agent 服务
│
├── test/                         # 集成测试
└── docs/
    └── expand/                   # 本目录
```

## 包依赖关系

```
                    ┌──────────────┐
                    │   @tx-cli/cli │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
       ┌──────────┐ ┌───────────┐ ┌───────────┐
       │  core    │ │  scaffold  │ │  shared   │
       └────┬─────┘ └───────────┘ └───────────┘
            │
            ▼
       ┌──────────┐
       │  shared  │
       └──────────┘

┌─────────────────┐     ┌─────────────────┐
│ @tx-cli/desktop │     │ @tx-cli/server  │
│   (Electron)    │     │   (Express+WS)  │
└────────┬────────┘     └────────┬────────┘
         │                       │
         ▼                       ▼
    ┌──────────┐           ┌──────────┐
    │   core   │           │   core   │
    └──────────┘           └──────────┘
```

## Phase 导航

| Phase | 标题 | 前置依赖 | 状态 | 文档 |
|---|---|---|---|---|
| 1 | pnpm + monorepo 拆分 | 无 | 待开始 | [phase-1-monorepo.md](./phase-1-monorepo.md) |
| 2 | core I/O 解耦 | Phase 1 | 待开始 | [phase-2-io-decoupling.md](./phase-2-io-decoupling.md) |
| 3 | 多模型/多 Provider 配置 | Phase 2 | 待开始 | [phase-3-multi-model.md](./phase-3-multi-model.md) |
| 4 | Electron 桌面端 | Phase 3 | 待开始 | [phase-4-desktop.md](./phase-4-desktop.md) |
| 5 | 云端 Agent 服务 | Phase 3 | 待开始 | [phase-5-cloud-server.md](./phase-5-cloud-server.md) |
| 6 | 打磨与发布 | Phase 4, 5 | 待开始 | [phase-6-polish.md](./phase-6-polish.md) |

## 实施原则

1. **每个 Phase 完成后 CLI 功能必须不变** — 所有现有测试必须通过
2. **按 Phase 顺序执行** — Phase 4 和 Phase 5 可以在 Phase 3 完成后并行
3. **每个 Task 完成后验证** — 按验收标准逐项检查
4. **最小改动原则** — 不做与当前 Task 无关的改动
