# Phase 2: core I/O 解耦（Channel 抽象）

> 前置依赖：Phase 1 完成
> 预计产出：core 包通过 Channel 接口与外部 I/O 交互，CLI 实现不变

## 概述

当前 core 包与终端 I/O 紧密耦合（直接使用 readline、console.log、prompts），无法被桌面端或云端复用。本阶段将 I/O 抽象为 Channel 接口，core 只依赖接口，各端提供自己的实现。

**核心原则：抽象 Channel 接口，CLI 实现不变，为桌面/云端做准备。**

---

## Task 2.1: 定义 Channel 接口

### 目标

在 core 包中定义所有 I/O 抽象接口。

### 涉及文件

- `packages/core/src/channels/types.ts` — 新建
- `packages/core/src/channels/index.ts` — 新建

### 步骤

#### Step 1: 创建 packages/core/src/channels/types.ts

```typescript
/**
 * I/O Channel 抽象层
 * core 包通过这组接口与外部交互，不直接依赖 readline/stdout/prompts
 */

/** 工具调用信息（用于 OutputChannel.toolCall） */
export interface ToolCallInfo {
  /** 工具名称 */
  name: string;
  /** 工具参数（JSON 字符串） */
  arguments: string;
  /** 自定义渲染文本（如 write_todos 的清单视图） */
  renderedCall?: string;
}

/** 用量信息 */
export interface UsageDisplayInfo {
  /** 本轮输入 token */
  inputTokens: number;
  /** 本轮输出 token */
  outputTokens: number;
  /** 累计输入 token */
  totalInputTokens: number;
  /** 累计输出 token */
  totalOutputTokens: number;
  /** 费用估算 */
  cost?: string;
}

/** 输入通道：接收用户输入 */
export interface InputChannel {
  /**
   * 等待用户输入一行文本
   * @param prompt - 提示文本（如 "> "）
   * @returns 用户输入的文本
   */
  readLine(prompt?: string): Promise<string>;
  /** 关闭输入通道 */
  close(): void;
}

/** 输出通道：向用户展示内容 */
export interface OutputChannel {
  /** 输出普通文本（一行） */
  text(content: string): void;
  /** 输出流式 token（LLM 逐步生成的正文） */
  streamToken(token: string): void;
  /** 输出流式思考 token */
  streamThinking(token: string): void;
  /** 结束思考块（补换行） */
  endThinking(): void;
  /** 输出工具调用信息 */
  toolCall(info: ToolCallInfo): void;
  /** 输出工具执行结果摘要 */
  toolResult(name: string, ok: boolean, summary?: string): void;
  /** 输出错误信息 */
  error(message: string): void;
  /** 输出警告信息 */
  warn(message: string): void;
  /** 输出系统提示信息 */
  system(message: string): void;
  /** 输出成功信息 */
  success(message: string): void;
  /** 输出弱化/次要信息 */
  dim(message: string): void;
  /** 输出用量统计 */
  usage(info: UsageDisplayInfo): void;
  /** 确保当前行尾有换行（从流式切换到非流式输出前调用） */
  ensureNewline(): void;
}

/** 交互提示通道：需要用户确认的交互 */
export interface PromptChannel {
  /**
   * 确认对话（是/否）
   * @param message - 提示信息
   * @returns 用户选择（true=是，false=否）
   */
  confirm(message: string): Promise<boolean>;
  /**
   * 选择对话（从选项中选择一项）
   * @param message - 提示信息
   * @param choices - 选项列表
   * @returns 用户选择的值
   */
  select(message: string, choices: Array<{ label: string; value: string }>): Promise<string>;
  /**
   * 输入对话（自由文本输入）
   * @param message - 提示信息
   * @param defaultValue - 默认值
   * @returns 用户输入的文本
   */
  input(message: string, defaultValue?: string): Promise<string>;
}

/** 会话通道集合：一次会话需要的所有 I/O */
export interface SessionChannels {
  input: InputChannel;
  output: OutputChannel;
  prompt: PromptChannel;
}
```

#### Step 2: 创建 packages/core/src/channels/index.ts

```typescript
export * from "./types";
```

#### Step 3: 更新 core 包的 index.ts

在 `packages/core/src/index.ts` 中添加：

```typescript
export * from "./channels";
```

### 验收标准

- [ ] `packages/core/src/channels/types.ts` 定义了完整的接口
- [ ] `pnpm --filter @tx-cli/core type-check` 通过

---

## Task 2.2: 实现 CLI Channel

### 目标

在 CLI 包中实现 Channel 接口的 CLI 版本。

### 涉及文件

- `packages/cli/src/channels/cli-input.ts` — 新建
- `packages/cli/src/channels/cli-output.ts` — 新建
- `packages/cli/src/channels/cli-prompt.ts` — 新建
- `packages/cli/src/channels/index.ts` — 新建

### 步骤

#### Step 1: 创建 packages/cli/src/channels/cli-output.ts

将现有 `renderer.ts` 中的输出逻辑迁移到这里：

```typescript
import pico from "picocolors";
import type { OutputChannel, ToolCallInfo, UsageDisplayInfo } from "@tx-cli/core";

/**
 * CLI 版输出通道：使用 stdout + picocolors
 * 从 renderer.ts 迁移输出逻辑
 */
export class CliOutputChannel implements OutputChannel {
  private lastStreamKind: "reasoning" | "content" | undefined;

  text(content: string): void {
    this.ensureNewline();
    console.log(content);
  }

  streamToken(token: string): void {
    if (this.lastStreamKind === "reasoning") {
      this.endThinking();
    }
    this.lastStreamKind = "content";
    process.stdout.write(token);
  }

  streamThinking(token: string): void {
    if (this.lastStreamKind !== "reasoning") {
      this.lastStreamKind = "reasoning";
      process.stdout.write(pico.dim("…… "));
    }
    process.stdout.write(pico.dim(token));
  }

  endThinking(): void {
    if (this.lastStreamKind === "reasoning") {
      process.stdout.write("\n");
      this.lastStreamKind = undefined;
    }
  }

  toolCall(info: ToolCallInfo): void {
    this.ensureNewline();
    if (info.renderedCall) {
      console.log(pico.cyan(info.renderedCall));
    } else {
      console.log(pico.cyan(`→ 调用 ${info.name}(${info.arguments})`));
    }
  }

  toolResult(name: string, ok: boolean, summary?: string): void {
    // CLI 版本默认不输出工具结果摘要（保持现有行为）
  }

  error(message: string): void {
    this.ensureNewline();
    console.error(pico.red(message));
  }

  warn(message: string): void {
    this.ensureNewline();
    console.warn(pico.yellow(message));
  }

  system(message: string): void {
    this.ensureNewline();
    console.log(pico.blue(message));
  }

  success(message: string): void {
    this.ensureNewline();
    console.log(pico.green(message));
  }

  dim(message: string): void {
    this.ensureNewline();
    console.log(pico.dim(message));
  }

  usage(info: UsageDisplayInfo): void {
    this.ensureNewline();
    // 从现有 usage.ts 迁移表格渲染逻辑
    // TODO: 实现用量表格输出
  }

  ensureNewline(): void {
    if (this.lastStreamKind !== undefined) {
      process.stdout.write("\n");
      this.lastStreamKind = undefined;
    }
  }
}
```

#### Step 2: 创建 packages/cli/src/channels/cli-input.ts

```typescript
import type { InputChannel } from "@tx-cli/core";

/**
 * CLI 版输入通道：封装 readline
 * 实际实现在 repl/input.ts 中，这里做适配
 */
export class CliInputChannel implements InputChannel {
  private rl: any; // readline.Interface

  constructor(rl: any) {
    this.rl = rl;
  }

  async readLine(prompt?: string): Promise<string> {
    // 委托给现有的 repl/input.ts 实现
    // TODO: 适配现有输入逻辑
    throw new Error("Not implemented");
  }

  close(): void {
    this.rl?.close();
  }
}
```

#### Step 3: 创建 packages/cli/src/channels/cli-prompt.ts

```typescript
import type { PromptChannel } from "@tx-cli/core";
import { confirmPrompt, selectPrompt, inputPrompt } from "@tx-cli/shared";

/**
 * CLI 版交互提示通道：封装 prompts 库
 * 从 interactive-prompt.ts 迁移
 */
export class CliPromptChannel implements PromptChannel {
  async confirm(message: string): Promise<boolean> {
    // 调用现有的 confirmPrompt
    return confirmPrompt(message);
  }

  async select(message: string, choices: Array<{ label: string; value: string }>): Promise<string> {
    return selectPrompt(message, choices);
  }

  async input(message: string, defaultValue?: string): Promise<string> {
    return inputPrompt(message, defaultValue);
  }
}
```

#### Step 4: 创建 packages/cli/src/channels/index.ts

```typescript
export { CliOutputChannel } from "./cli-output";
export { CliInputChannel } from "./cli-input";
export { CliPromptChannel } from "./cli-prompt";
```

### 验收标准

- [ ] 三个 CLI Channel 类创建完成
- [ ] `pnpm --filter @tx-cli/cli type-check` 通过

---

## Task 2.3: 改造 conversation 层接收 Channel

### 目标

让 conversation 层的公共入口接收 SessionChannels，内部用 Channel 替代直接 I/O。

### 涉及文件

- `packages/core/src/conversation/index.ts` — 修改
- `packages/core/src/conversation/one-shot.ts` — 修改
- `packages/core/src/conversation/repl/repl.ts` — 修改
- `packages/core/src/conversation/loop/renderer.ts` — 修改
- `packages/core/src/conversation/loop/execute-turn.ts` — 修改
- `packages/core/src/conversation/loop/loop.ts` — 修改
- `packages/core/src/conversation/session/runtime.ts` — 修改

### 步骤

#### Step 1: 修改 runOneShotConversation 签名

在 `packages/core/src/conversation/index.ts` 中，为 `runOneShotConversation` 添加 `channels` 参数：

```typescript
// 修改前
export async function runOneShotConversation(options: {
  llmConfig: LlmConfig;
  modeConfig: ConversationModeConfig;
  userInput: string;
  thinkingLevel?: ThinkingLevel;
  mcpEnabled?: boolean;
  cliSandboxOptions?: SandboxCliOptions;
}): Promise<void>

// 修改后
export async function runOneShotConversation(options: {
  llmConfig: LlmConfig;
  modeConfig: ConversationModeConfig;
  userInput: string;
  thinkingLevel?: ThinkingLevel;
  mcpEnabled?: boolean;
  cliSandboxOptions?: SandboxCliOptions;
  channels: SessionChannels;  // 新增
}): Promise<void>
```

#### Step 2: 修改 runReplConversation 签名

同样为 `runReplConversation` 添加 `channels` 参数。

#### Step 3: 改造 one-shot.ts

将 `one-shot.ts` 中的 `console.log`、`process.stdout.write` 替换为 `channels.output.*`：

- `console.log(...)` → `channels.output.text(...)`
- `console.error(...)` → `channels.output.error(...)`
- `process.stdout.write(token)` → `channels.output.streamToken(token)`

#### Step 4: 改造 renderer.ts

将 `renderer.ts` 中的直接输出替换为 `channels.output.*`：

- 思考增量输出 → `channels.output.streamThinking(token)`
- 正文增量输出 → `channels.output.streamToken(token)`
- 工具调用提示 → `channels.output.toolCall(info)`
- 软收敛提示 → `channels.output.warn(message)`

#### Step 5: 改造 repl.ts

将 `repl.ts` 中的 readline 调用替换为 `channels.input.readLine()`。

#### Step 6: 改造 execute-turn.ts 和 loop.ts

将 channels 传递到各执行环节。

### 验收标准

- [ ] `runOneShotConversation` 和 `runReplConversation` 接收 channels 参数
- [ ] 所有直接 I/O 调用已替换为 Channel 调用
- [ ] `pnpm --filter @tx-cli/core type-check` 通过

---

## Task 2.4: 改造交互层

### 目标

将交互提示（审批、确认、选择）通过 Channel 接口处理。

### 涉及文件

- `packages/shared/src/interactive-prompt.ts` — 修改（或迁移到 core）
- `packages/core/src/tools/executor.ts` — 修改
- `packages/core/src/sandbox/runtime/interactive-approver.ts` — 修改
- `packages/core/src/llm/config-wizard.ts` — 修改

### 步骤

#### Step 1: 改造 interactive-prompt.ts

将 `interactive-prompt.ts` 中的函数改为接收 `PromptChannel` 参数，或者将其迁移到 core 包中作为 Channel 的默认实现。

方案 A（推荐）：保持 `interactive-prompt.ts` 在 shared 包中，但改为接受 `PromptChannel` 参数：

```typescript
// 修改前
export async function confirmPrompt(message: string): Promise<boolean>

// 修改后
export async function confirmPrompt(channel: PromptChannel, message: string): Promise<boolean> {
  return channel.confirm(message);
}
```

方案 B：将交互逻辑移到 core 包的 channels 中，shared 包只保留纯工具函数。

#### Step 2: 改造 executor.ts

将工具执行中的审批调用从直接调用 `interactive-prompt` 改为通过 `channels.prompt.confirm()`。

#### Step 3: 改造 interactive-approver.ts

将沙箱审批器的交互调用改为通过 `channels.prompt.*`。

#### Step 4: 改造 config-wizard.ts

将配置向导的交互调用改为通过 `channels.prompt.*`。

### 验收标准

- [ ] 所有交互调用通过 Channel 接口
- [ ] `pnpm --filter @tx-cli/core type-check` 通过

---

## Task 2.5: CLI 入口接线

### 目标

在 CLI 命令层创建 Channel 实例并传入 conversation。

### 涉及文件

- `packages/cli/src/program/command/agent-command.ts` — 修改
- `packages/cli/src/program/command/chat-command.ts` — 修改

### 步骤

#### Step 1: 修改 agent-command.ts

```typescript
import { CliOutputChannel, CliInputChannel, CliPromptChannel } from "../channels";

// 在 runAgentAction 中
const channels = {
  output: new CliOutputChannel(),
  input: new CliInputChannel(rl),
  prompt: new CliPromptChannel(),
};

await runOneShotAgent({
  llmConfig,
  task: taskText,
  thinkingLevel,
  mcpEnabled,
  cliSandboxOptions,
  channels,  // 传入 channels
});
```

#### Step 2: 修改 chat-command.ts

同样为 chat 命令添加 channels 参数。

#### Step 3: 修改 agent.ts 和 chat.ts

在 `packages/core/src/conversation/agent.ts` 和 `chat.ts` 中，为 `runOneShotAgent`、`runReplAgent`、`runOneShotChat`、`runReplChat` 添加 channels 参数并传递。

### 验收标准

- [ ] CLI 命令能正常创建 Channel 并传入
- [ ] `pnpm dev -- chat "你好"` 正常对话
- [ ] `pnpm dev -- agent "列出当前目录文件"` 正常执行

---

## Task 2.6: 测试验证

### 目标

确保所有测试通过，CLI 功能不变。

### 步骤

#### Step 1: 更新测试

更新测试文件，为 conversation 函数传入 mock Channel。

#### Step 2: 运行全部测试

```bash
pnpm test
```

#### Step 3: 运行类型检查

```bash
pnpm type-check
```

#### Step 4: 功能验证

```bash
pnpm dev -- --help
pnpm dev -- chat "你好"
pnpm dev -- agent "列出当前目录文件"
```

### 验收标准

- [ ] 全部测试通过
- [ ] 类型检查无错误
- [ ] CLI 功能与改造前一致
