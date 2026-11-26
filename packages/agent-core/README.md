# @tanyueran/agent-core

tx-cli 的无头核心引擎（private 包），承载 `chat` 与 `agent` 两个命令的全部会话能力：对话编排、agentic loop、工具系统、沙箱与审批、LLM 接入、MCP 与技能。

- 不依赖终端、REPL、ANSI 着色或任何前端框架，只通过 `channels` 契约与外部交互；
- 只依赖 `@tanyueran/agent-common`；
- CLI、桌面端与云端复用同一套 [`ConversationSession`](src/conversation/session/conversation-session.ts)，不需要各自复制多轮控制逻辑。

## 模块结构

| 目录 | 职责 |
|---|---|
| `channels/` | 跨端 I/O 契约（纯类型）：`InputChannel`、`OutputChannel`、`PromptChannel`、`SessionChannels` |
| `conversation/` | 会话编排：`chat.ts` / `agent.ts` 模式配置、`one-shot.ts` 单次入口、`session/` 运行时与多轮会话、`loop/` 回合执行与压缩、`sub-agent/` 子 Agent |
| `tools/` | `Tool` 接口、执行器、权限门卫、内置工具与注册表 |
| `sandbox/` | 沙箱四层模型：装配（bootstrap）、配置（config）、规则（policy）、运行时（runtime）、Provider（providers） |
| `llm/` | 配置装载、Responses 流式客户端、思考档位适配、上下文压缩配置、用量与费用计算 |
| `mcp/` | MCP 配置解析、连接管理、工具适配与折叠发现 |
| `skills/` | 技能扫描与 `load_skill` 工具 |

子路径导出：`./channels`、`./conversation/*`、`./llm/*`、`./tools/*`、`./mcp/*`、`./sandbox/*`、`./skills/*`。

## 会话机制

`chat` 与 `agent` 共用同一套机制，差异收敛为一份 [`ConversationModeConfig`](src/conversation/session/mode.ts)：

| 维度 | chat | agent |
|---|---|---|
| 写侧工具（`write_file` / `edit_file`） | 不装配（只读由代码强制） | 装配 |
| bash | 不装配 | 缺省装配，受沙箱与审批管控 |
| `write_todos` | 不装配 | 装配 |
| 子 Agent 工具带 | 不装配 | 装配 `delegate_task` / `task_status` / `task_stop` |
| MCP | 关闭 | 缺省开启 |
| 工具调用轮数上限 | 8 | 40 |
| 思考档位兜底 | `low` | `medium` |

入口 API：

- **单次**：`runOneShotChat` / `runOneShotAgent` → `runOneShotConversation`，会话结束即释放运行时；
- **多轮**：`ConversationSession.create(...)`，提供 `runTurn`（串行回合）、`setThinkingLevel`、`clear`、`exportSession`、`awaitBackgroundTasksOnExit`、`dispose`；
- **运行时**：`createConversationRuntime` 统一装配 MCP、沙箱、技能与工具清单。

## 内置工具

| 工具 | 说明 |
|---|---|
| `read_file` / `list_dir` / `glob` / `grep` | 读取与检索本地文件（受沙箱禁读边界管控） |
| `web_search` / `web_fetch` | 联网搜索与网页抓取（仅公网 http/https，长页面可 `offset` 续读） |
| `write_file` / `edit_file` | 写侧工具，仅 agent 模式装配，经权限门卫与 fs 边界校验 |
| `write_todos` | 任务清单（agent 模式），全量替换式维护 |
| `bash` | 沙箱内执行命令，默认超时 605s |
| `load_skill` | 仅扫描到技能时装配 |
| `discover_mcp_tools` | MCP 工具超过 8 个时折叠为按需发现 |
| `delegate_task` / `task_status` / `task_stop` | 子 Agent 派生与后台任务管理（仅 agent 模式） |

工具调用统一经 `executeToolCall`：参数 JSON 解析失败转为失败结果回传模型重试；默认超时 30s（MCP 60s、bash 605s）；输出超过 8192 字符截断；工具异常转为 `ok:false` 结果，不中断会话（`CancelError` 除外）。

## 沙箱与权限

三档沙箱与审批策略正交：

| 档位 | 文件系统 | 网络 |
|---|---|---|
| `read-only`（默认） | 全禁写，默认禁读 `~/.ssh` / `~/.aws` / `~/.gnupg` 等 | 全禁 |
| `workspace-write` | 可写 cwd、临时目录与 `filesystem.writableRoots`，敏感文件仍禁写 | 仅 `network.allowedDomains` 白名单 |
| `danger-full-access` | 无隔离 | 无限制 |

审批策略：`always-ask` / `on-failure`（默认，沙箱拦截失败时提供升级重跑）/ `never`。判定链路为 L1 装配（CLI > 项目配置 > 全局配置，能力感知合并）→ L2 规则（`deny > ask > allow > 档位默认`）→ L3 审批（本次 / 本会话 / 始终允许，授权落项目配置）→ L4 Provider 执行；所有拦截与审批写入 `~/.tx-cli/sandbox-audit.jsonl`。模块内部细节见 [sandbox/README.md](src/sandbox/README.md)。

## LLM 接入

- 走 OpenAI 兼容 Responses API **无状态模式**（`store: false`），历史由本地维护并每轮全量发送；
- 思考档位 `off` / `low` / `medium` / `high`，优先级：命令行 > 项目配置 > 全局配置 > 模式兜底；
- 协议差异收敛在 [`thinking.ts`](src/llm/thinking.ts)：按 `baseUrl` 推断 `reasoning_effort` / `thinking` / `enable_thinking` / `none` 风格，可用 `llm.thinkingStyle` 显式覆盖；
- 支持上下文自动压缩（`llm.context.maxContextTokens`）与 token 用量 / 费用估算（`llm.pricing`）。

## 配置

全局配置 `~/.tx-cli/config.json`（0600），项目配置 `<cwd>/.tx-cli/config.json`，按字段合并（项目配置的多数放宽类字段受限）：

| 段 | 职责 |
|---|---|
| `llm` | `baseUrl` / `apiKey` / `model`、`thinkingLevel` / `thinkingStyle` / `thinkingEffortMap`、`context`、`pricing` |
| `mcpServers` | MCP 服务器（stdio / http） |
| `mcp.rules` | MCP 工具 allow / ask / deny 规则 |
| `sandbox` | 档位、审批、`filesystem`、`network`、规则与 bash 开关 |

辅助位置：`~/.tx-cli/sandbox-audit.jsonl`（审计）、`~/.tx-cli/skills` 与 `./.tx-cli/skills`（技能）、`<cwd>/.tx-cli/config.json`（「始终允许」授权落盘）。

```jsonc
{
  "llm": {
    "context": { "maxContextTokens": 128000, "compactAt": 0.7 },
    "pricing": { "inputPerMillion": 2, "outputPerMillion": 8, "currency": "¥" }
  }
}
```

## 使用示例

```ts
import {
  CHAT_MODE_CONFIG,
  ConversationSession,
  loadLlmConfig,
} from "@tanyueran/agent-core";

// channels 由各端实现，CLI 实现见 packages/cli/src/channels
const llmConfig = await loadLlmConfig(channels);
const session = await ConversationSession.create({
  llmConfig,
  modeConfig: CHAT_MODE_CONFIG,
  channels,
});

await session.runTurn("这个仓库是做什么的？");
await session.dispose();
```

## 扩展点

| 需求 | 入口 |
|---|---|
| 新增内置工具 | `src/tools/builtin/` 实现 `Tool` 并加入 `builtinTools`；需管控时声明 `permission` |
| 新增沙箱实现 | `src/sandbox/providers/` 实现 `SandboxProvider` 并在 `registry.ts` 注册 |
| 接入新 LLM 协议差异 | 收敛在 `src/llm/thinking.ts` |
| 新增端（桌面 / 云端） | 实现 `channels` 契约并复用 `ConversationSession`，不得让 core 反向依赖前端 |

更多设计说明见 [项目架构](../../docs/ARCHITECTURE.md)。

## 开发

```bash
pnpm --filter @tanyueran/agent-core type-check
pnpm --filter @tanyueran/agent-core build
pnpm test packages/agent-core
```
