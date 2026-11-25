# Phase 3: 包职责与依赖边界收口

> 前置依赖：Phase 2 完成
> 预计产出：保留 shared/core/scaffold/cli 四包，core 成为无终端展示依赖的核心引擎，scaffold 只负责模板能力，CLI 功能不变

## 概述

Phase 1 完成了 monorepo 的物理拆分，Phase 2 完成了输入输出通道抽象，但当前仍有三个边界问题：

1. `core/conversation` 的桶导出与子 Agent 模块存在循环导入。
2. `core` 仍包含终端 REPL、面板和 ANSI 着色，桌面端与云端无法把它当作纯核心引擎复用。
3. `scaffold` 同时承载 copy、静态服务器、ONES 信息转换，并仅为 Channel 类型依赖 `core`。

本阶段在多模型、桌面端和云端开发之前收口包边界。**不新增 package，不拆分 llm/mcp/sandbox/skills，不改变用户功能和配置格式。**

**核心原则：依赖单向、core 无头化、scaffold 专注模板、CLI 功能不变。**

### 目标依赖关系

```text
cli ──────> core ──────> shared
 │                         ↑
 ├──────> scaffold ────────┘
 │                         ↑
 └─────────────────────────┘

shared：不依赖任何 workspace 包
core：只依赖 shared，不依赖 cli/scaffold/desktop/server，不依赖 picocolors
scaffold：只依赖 shared，不依赖 core
cli：可以依赖 core/scaffold/shared
desktop/server：后续只复用 core/shared，不依赖 cli
```

### 目标职责划分

```text
packages/
├── shared/src/                  # 通用工具、错误、取消、配置读写
├── core/src/
│   ├── channels/                # 跨端 I/O 契约
│   ├── conversation/
│   │   ├── session/             # 会话装配、无头多轮会话、运行时与通用导出
│   │   ├── loop/                # 回合与 agentic loop
│   │   ├── sub-agent/           # 子 Agent 执行、调度、工具壳
│   │   ├── agent.ts             # Agent 模式配置与单次入口
│   │   ├── chat.ts              # Chat 模式配置与单次入口
│   │   └── one-shot.ts          # 单次会话
│   ├── llm/                     # 模型接入与配置，不含终端着色
│   ├── tools/                   # 工具定义与执行
│   ├── mcp/                     # MCP 连接与发现
│   ├── sandbox/                 # 沙箱与审批机制
│   └── skills/                  # 技能发现与加载
├── scaffold/src/scaffold/       # 模板发现、渲染与通用生成流程
└── cli/src/
    ├── channels/                # TTY Channel 实现
    ├── conversation/
    │   ├── repl/                # 终端 REPL、输入帧、面板、斜杠命令
    │   ├── agent.ts             # Agent 终端多轮入口
    │   └── chat.ts              # Chat 终端多轮入口
    ├── services/
    │   ├── copy/                # copy 命令服务
    │   ├── server/              # 静态服务器命令服务
    │   └── commit-fix/          # ONES commit message 转换
    └── program/command/         # Commander 适配层
```

---

## Task 3.1: 解除 conversation 内部循环依赖

### 目标

消除桶文件反向引用和子 Agent 执行核、调度器、工具壳之间的循环导入。

### 涉及文件

- `packages/core/src/conversation/index.ts` — 修改
- `packages/core/src/conversation/agent.ts` — 修改
- `packages/core/src/conversation/chat.ts` — 修改
- `packages/core/src/conversation/sub-agent/attach.ts` — 修改
- `packages/core/src/conversation/sub-agent/dispatcher.ts` — 修改
- `packages/core/src/conversation/sub-agent/tools.ts` — 修改
- `packages/core/src/conversation/sub-agent/types.ts` — 新建
- `packages/core/src/conversation/sub-agent/utils.ts` — 新建

### 步骤

#### Step 1: 移除 agent/chat 对桶入口的引用

将 `agent.ts`、`chat.ts` 中的 `from "."` 改为直接引用 `one-shot.ts` 和 `repl/repl.ts`。此处允许暂时引用 REPL，Task 3.2 会完成最终迁移。

#### Step 2: 提取子 Agent 公共契约

把 `SubAgentRequest`、`SubAgentRunResult`、`SubAgentRunner`、`SubAgentControl` 等跨模块类型移至 `sub-agent/types.ts`。类型定义不得反向导入 `attach.ts`。

#### Step 3: 提取无副作用工具函数

把 `buildTaskPreview` 等同时被 `dispatcher.ts`、`tools.ts` 使用的纯函数移至 `sub-agent/utils.ts`，使依赖方向变为：

```text
attach ──────> dispatcher ──────> types/utils
  │                  ↑
  └──────> tools ────┘
```

`dispatcher.ts` 和 `tools.ts` 不再导入 `attach.ts`。

#### Step 4: 收敛桶导出

`conversation/index.ts` 只作为对外出口，包内文件不得通过它反向引用同包实现。优先导入具体文件，避免经子目录桶文件形成隐蔽环路。

### 验收标准

- [x] `agent.ts`、`chat.ts` 不再从 `"."` 导入
- [x] `dispatcher.ts`、`tools.ts` 不再导入 `attach.ts`
- [x] 子 Agent 同步派生、后台派生、状态查询和停止行为不变
- [x] `pnpm type-check` 与 `pnpm test` 通过

---

## Task 3.2: 抽取无头多轮会话并迁移终端 REPL

### 目标

先把现有 REPL 中可跨端复用的会话状态与回合编排提取为 core API，再把终端输入帧、面板和斜杠命令移至 `cli`，避免桌面端和云端重复实现 history、子 Agent、压缩与资源释放。

### 涉及文件

- `packages/core/src/conversation/session/conversation-session.ts` — 新建无头多轮会话
- `packages/core/src/conversation/repl/state.ts` — 拆分通用会话状态与终端状态
- `packages/core/src/conversation/repl/background.ts` — 拆分后台事件收割与终端输入竞速
- `packages/core/src/conversation/repl/repl.ts` — 迁移至 `packages/cli/src/conversation/repl/`
- `packages/core/src/conversation/repl/panel.ts` — 迁移至 `packages/cli/src/conversation/repl/`
- `packages/core/src/conversation/repl/input.ts` — 迁移至 `packages/cli/src/conversation/repl/`
- `packages/core/src/conversation/repl/slash-commands.ts` — 迁移至 `packages/cli/src/conversation/repl/`
- `packages/core/src/conversation/repl/session-export.ts` — 迁移至 `packages/core/src/conversation/session/session-export.ts`
- `packages/core/src/conversation/agent.ts` — 修改，仅保留模式配置与 `runOneShotAgent`
- `packages/core/src/conversation/chat.ts` — 修改，仅保留模式配置与 `runOneShotChat`
- `packages/cli/src/conversation/agent.ts` — 新建，承载 `runReplAgent`
- `packages/cli/src/conversation/chat.ts` — 新建，承载 `runReplChat`
- `packages/core/src/conversation/index.ts` — 修改
- `packages/cli/src/channels/cli-input.ts` — 修改
- `packages/cli/src/channels/cli-output.ts` — 修改
- `packages/cli/src/program/command/agent-command.ts` — 修改
- `packages/cli/src/program/command/chat-command.ts` — 修改

### 步骤

#### Step 1: 抽取 core 无头多轮会话

新增 `ConversationSession`，集中持有 `ConversationRuntime`、跨轮 `history`、思考档位与协议风格、累计用量、压缩配置、子 Agent 工具句柄和调度器。至少提供创建、串行 `runTurn`、思考档位切换、清空会话、协作式取消和幂等 `dispose` 能力。

把 `state.ts` 中子 Agent 装配、后台事件历史注入、usage 汇总等通用逻辑一并收口到该会话或其 core 协作模块。取消时回滚未完整提交的历史，释放时关闭 MCP 和沙箱；CLI、桌面端和云端不得各自复制这套逻辑。

#### Step 2: 迁移终端专属 REPL

将 `repl.ts`、`panel.ts`、`input.ts`、`slash-commands.ts` 以及 `state.ts/background.ts` 中输入历史、草稿恢复、输入等待竞速、命令注册和终端通知等部分迁移到 `packages/cli/src/conversation/repl/`。CLI REPL 改为组合 core 的 `ConversationSession`，不再自行装配子 Agent 或维护另一份回合执行机制。

`session-export.ts` 不依赖终端输入帧，保留在 core 的 `session/` 中供各端复用。

#### Step 3: 拆分单次与多轮入口

core 的 `agent.ts`、`chat.ts` 保留 `AGENT_MODE_CONFIG`、`CHAT_MODE_CONFIG` 和单次入口。把 `runReplAgent`、`runReplChat` 移到 CLI 薄包装中，由 CLI 调用本地 `runReplConversation`。

依赖方向只能是 `cli → core`，不得为了复用 REPL 让 core 注入或导入 cli。

#### Step 4: 更新 CLI 接线

`agent-command.ts`、`chat-command.ts` 的单次入口继续从 `@tx-cli/core` 导入，多轮入口改为从 CLI 本地模块导入。`cli-input.ts`、`cli-output.ts` 对 REPL 控制器和展示类型的引用改为 CLI 本地路径。

#### Step 5: 收敛 core 公开出口

从 core 桶导出中删除 REPL 专属 API，公开 `ConversationSession`、`runOneShotConversation`、`executeConversationTurn`、会话运行时、loop、sub-agent、Channel 和通用会话导出能力。后续桌面端与云端优先使用 `ConversationSession`，不重复实现多轮控制。

### 验收标准

- [x] `packages/core/src/conversation/repl/` 不再存在
- [x] core 不导入 `@tx-cli/cli`，也不包含 REPL 专属导出
- [x] CLI 与后续非终端入口可复用同一个 `ConversationSession` 完成多轮、子 Agent、压缩、取消和资源释放
- [x] `chat`、`agent` 的单次和多轮 CLI 行为与改造前一致
- [x] REPL 补全、斜杠命令、后台任务通知、会话导出行为不回归

---

## Task 3.3: 移除 core 的 ANSI 与终端展示依赖

### 目标

core 只产生语义化事件和纯文本，颜色、表格与终端布局由各前端自行呈现。

### 涉及文件

- `packages/core/src/conversation/one-shot.ts` — 修改
- `packages/core/src/conversation/loop/renderer.ts` — 修改
- `packages/core/src/conversation/loop/execute-turn.ts` — 修改
- `packages/core/src/conversation/sub-agent/attach.ts` — 修改
- `packages/core/src/conversation/sub-agent/tools.ts` — 修改
- `packages/core/src/llm/config.ts` — 修改
- `packages/core/src/llm/config-wizard.ts` — 修改
- `packages/core/src/llm/thinking.ts` — 修改
- `packages/core/src/llm/usage.ts` — 修改
- `packages/core/src/tools/builtin/write-todos.ts` — 修改
- `packages/core/src/sandbox/bootstrap/trust.ts` — 修改
- `packages/core/src/sandbox/runtime/interactive-approver.ts` — 修改
- `packages/core/package.json` — 修改
- `packages/cli/src/channels/cli-output.ts` — 修改

### 步骤

#### Step 1: 用语义化 Channel 替代颜色

警告、错误、成功、次要信息分别使用 `output.warn/error/success/dim/system`，不要在 core 中预先拼接 ANSI 色码。普通 `output.text` 只接收纯文本。

CLI Channel 负责把语义事件映射为颜色；桌面端和 WebSocket Channel 直接映射为 UI 状态或消息类型。

#### Step 2: 保持工具结果为纯数据或纯文本

`ToolCallInfo.renderedCall`、todo 清单、子 Agent 进度和沙箱审批内容不再包含 ANSI。需要强调的样式由 CLI 在展示层根据信息类型添加。

#### Step 3: 迁移用量表格格式化

把终端专用的用量表格对齐和着色逻辑移至 `cli-output.ts` 或 CLI 展示辅助模块。core 的 `llm/usage.ts` 只保留用量计算、汇总和价格计算等通用逻辑。

#### Step 4: 删除 core 的颜色依赖

完成全部替换后，从 `packages/core/package.json` 删除 `picocolors`，并清理相关导出、测试快照与 mock。

### 验收标准

- [x] core 生产源码不再导入 `picocolors`
- [x] core 不直接依赖 `console`、`readline`、`process.stdin/stdout/stderr`
- [x] core 发送给 IPC/WebSocket 的内容不含 ANSI 控制字符
- [x] CLI 的颜色、用量表格和提示层级与改造前基本一致

---

## Task 3.4: 收口 scaffold 并迁移 CLI 专属服务

### 目标

`scaffold` 只负责模板能力与通用生成流程，copy、静态服务器和 ONES 转换归回 CLI 应用服务层。

### 涉及文件

- `packages/scaffold/src/copy/` — 迁移至 `packages/cli/src/services/copy/`
- `packages/scaffold/src/server/` — 迁移至 `packages/cli/src/services/server/`
- `packages/scaffold/src/commit-fix/` — 迁移至 `packages/cli/src/services/commit-fix/`
- `packages/scaffold/src/scaffold/index.ts` — 修改
- `packages/scaffold/src/index.ts` — 修改
- `packages/scaffold/package.json` — 修改
- `packages/scaffold/tsconfig.json` — 修改
- `packages/cli/src/program/command/` — 修改相关命令引用
- `packages/cli/package.json` — 修改

### 步骤

#### Step 1: 迁移三个 CLI 专属服务

移动 `copy`、`server`、`commit-fix` 的实现，保持对外函数和行为不变。对应命令改为引用 CLI 本地服务，不再从 `@tx-cli/scaffold` 导入。

这些能力不得移入 `shared`，也暂不为每个命令创建新 package。

#### Step 2: 定义 scaffold 最小端口

在 scaffold 内定义自身所需的 `ScaffoldPrompt`、`ScaffoldOutput` 最小接口，仅包含生成流程实际使用的 `confirm/select/input` 和语义化输出方法。

利用 TypeScript 结构化类型直接接收现有 CLI Channel，删除对 `@tx-cli/core/channels` 的类型依赖，不为此新增 contracts 包。

#### Step 3: 保持通用生成流程可复用

`runScaffold`、模板发现、文件名映射和渲染继续留在 scaffold。移除流程中的 ANSI 着色，由语义化输出或 CLI 命令层负责展示。

#### Step 4: 收敛导出与包依赖

`scaffold/src/index.ts` 只导出模板与生成流程相关 API。删除 scaffold 对 core、`picocolors`、`simple-git`、`connect`、`serve-static` 及对应类型包的依赖，保留实际使用的 `shared`、`fs-extra`、`handlebars`。

将 copy/server 所需运行时依赖和类型依赖明确声明在 CLI 包中，并删除 `scaffold/tsconfig.json` 的 core paths。

### 验收标准

- [x] scaffold 不再依赖或导入 core
- [x] scaffold 不再导出 copy/server/commit-fix
- [x] `create/add/copy/server/commit-fix` 命令行为不变
- [x] `pnpm --filter @tx-cli/scaffold type-check` 通过
- [x] 静态服务器有直接单元测试，覆盖启动、404 和监听失败

---

## Task 3.5: 固定公开出口并增加依赖守卫

### 目标

把目标依赖方向变成可自动检查的规则，避免后续多 Provider、桌面端和云端开发重新引入反向依赖或循环依赖。

### 涉及文件

- `packages/core/package.json` — 修改 exports
- `packages/scaffold/package.json` — 修改 exports
- `package.json`（根）— 新增依赖检查脚本
- `.dependency-cruiser.mjs` — 新建（实施时采用 ESM 配置）
- `eslint.config.mjs` — 按需补充导入限制

### 步骤

#### Step 1: 核对包公开出口

core 明确导出后续桌面端和云端需要的 Channel、session、loop、one-shot 等入口，不导出 CLI REPL。若保留子路径导入，补齐精确的 `./channels` export，避免实际引用与 exports 声明不一致。

scaffold 只公开模板相关入口，CLI 专属服务不作为 workspace 公共 API。

#### Step 2: 增加依赖检查

使用 dependency-cruiser 检查 TypeScript 源码，至少配置以下规则：

- 禁止任何循环依赖，排除测试中的合理 mock 依赖时需逐项说明
- `shared` 不得依赖其他 workspace 包
- `core` 只能依赖 `shared`
- `scaffold` 只能依赖 `shared`
- `desktop/server` 不得依赖 `cli`
- 禁止通过深层相对路径绕过 workspace 包公开出口（实施时由 `eslint.config.mjs` 的 `no-restricted-imports` 承担：depcruise 的 local 依赖类型无法区分 tsconfig paths 别名与相对路径）

#### Step 3: 接入根脚本

增加 `deps:check` 脚本，并让后续 CI 在类型检查前执行。依赖检查只分析源码，不要求先构建产物。

### 验收标准

- [x] `pnpm deps:check` 能发现人为制造的循环依赖和反向依赖
- [x] 当前四包全部通过依赖规则
- [x] core 与 scaffold 的 exports 和实际导入方式一致

---

## Task 3.6: 测试迁移与整体验证

### 目标

让测试目录与新的职责边界一致，并验证源码、构建产物和 CLI 关键流程均无回归。

### 涉及文件

- `packages/core/test/conversation-session.test.ts` — 新建无头多轮会话测试
- `packages/core/test/repl-input.test.ts` — 迁移至 `packages/cli/test/`
- `packages/core/test/repl-slash-commands.test.ts` — 迁移至 `packages/cli/test/`
- `packages/core/test/session-export.test.ts` — 修改导入路径
- `packages/core/test/llm-usage.test.ts` — 拆分通用计算与终端表格用例
- `packages/scaffold/test/copy.test.ts` — 迁移至 `packages/cli/test/`
- `packages/scaffold/test/ones-message.test.ts` — 迁移至 `packages/cli/test/`
- `packages/cli/test/command-actions.test.ts` — 修改单次与多轮入口 mock
- `packages/cli/test/server.test.ts` — 新建

### 步骤

#### Step 1: 按职责迁移测试

REPL、CLI 服务和终端表格测试归入 CLI；无头多轮会话、会话导出、回合、子 Agent 和通用用量计算测试留在 core；模板测试留在 scaffold。`conversation-session.test.ts` 至少覆盖跨轮 history、子 Agent 装配、串行回合、取消回滚和幂等资源释放。

#### Step 2: 运行静态检查

```bash
pnpm deps:check
pnpm type-check
pnpm lint
pnpm test
```

#### Step 3: 验证构建产物

```bash
pnpm build
node packages/cli/bin/tx-cli --help
```

在临时目录分别验证 `create/add/copy/server/commit-fix`，并使用有效测试配置验证 `chat/agent` 的单次与多轮流程。不得在项目源码目录执行会覆盖文件的脚手架验收。

#### Step 4: 核对最终边界

确认 core 无 REPL、无 ANSI、无 CLI 依赖；scaffold 无 core 依赖和非模板服务；后续桌面端与云端所需的 core API 不经过 CLI。

### 验收标准

- [x] 依赖检查、类型检查、lint、全部测试和构建通过
- [x] 构建后的 CLI 能正常启动并展示帮助
- [x] 现有 CLI 命令关键流程无功能回归
- [x] 测试归属与新包边界一致
- [x] 未引入新 package，未修改 LLM 配置格式
