# Phase 5: Electron 桌面端

> 前置依赖：Phase 4 完成
> 预计产出：可运行的 Electron 桌面应用，支持 Agent/Chat 切换、多模型切换

## 概述

基于 Electron + React 构建桌面应用，复用 Phase 3 完成无头化后的 `@tx-cli/core` 会话机制，通过 IPC Channel 连接主进程与渲染进程。桌面主进程复用 core 的 `ConversationSession`，由 core 统一持有 runtime、跨轮 history、子 Agent、压缩、取消与资源释放；桌面端只管理 GUI 会话映射，不复用 CLI 的终端 REPL，也不重复实现回合控制。`desktop` 对 workspace 包的依赖仅限 `core/shared`，不依赖 `cli`。

**核心原则：复用无头 core，自持桌面多轮会话，通过 IPC Channel 对接。**

---

## Task 5.1: 搭建 Electron 项目骨架

### 目标

初始化 `packages/desktop/` 项目，配置 electron-vite、React、TypeScript。

### 涉及文件

- `packages/desktop/package.json` — 新建
- `packages/desktop/electron.vite.config.ts` — 新建
- `packages/desktop/tsconfig.json` — 新建
- `packages/desktop/index.html` — 新建

### 步骤

#### Step 1: 创建 packages/desktop/package.json

```json
{
  "name": "@tx-cli/desktop",
  "version": "0.11.0",
  "private": true,
  "type": "module",
  "main": "./dist/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "type-check": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@tx-cli/core": "workspace:*",
    "@tx-cli/shared": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/node": "^26.4.1",
    "electron": "^35.0.0",
    "electron-vite": "^4.0.0",
    "electron-builder": "^26.0.0",
    "vite": "^7.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "typescript": "5.9.2"
  }
}
```

#### Step 2: 创建 electron.vite.config.ts

```typescript
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts"),
      },
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: resolve(__dirname, "index.html"),
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer"),
      },
    },
  },
});
```

#### Step 3: 创建 tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"],
    "jsx": "react-jsx",
    "paths": {
      "@/*": ["./src/renderer/*"],
      "@tx-cli/core": ["../core/src/index.ts"],
      "@tx-cli/shared": ["../shared/src/index.ts"]
    }
  },
  "include": ["./src/**/*"]
}
```

#### Step 4: 创建 index.html

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>tx-cli Desktop</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/renderer/main.tsx"></script>
</body>
</html>
```

#### Step 5: 安装依赖

```bash
pnpm install
```

### 验收标准

- [ ] `packages/desktop/` 项目结构完整
- [ ] `pnpm --filter @tx-cli/desktop type-check` 通过
- [ ] `pnpm --filter @tx-cli/desktop dev` 能启动 Electron 窗口

---

## Task 5.2: 实现桌面版 Channel

### 目标

实现 IPC 版本的 InputChannel、OutputChannel、PromptChannel。

### 涉及文件

- `packages/desktop/src/main/channels/ipc-output.ts` — 新建
- `packages/desktop/src/main/channels/ipc-input.ts` — 新建
- `packages/desktop/src/main/channels/ipc-prompt.ts` — 新建

### 步骤

#### Step 1: 创建 ipc-output.ts

```typescript
import type { OutputChannel, ToolCallInfo, UsageDisplayInfo } from "@tx-cli/core";
import type { WebContents } from "electron";

/**
 * 桌面版输出通道：通过 IPC 推送到渲染进程
 */
export class IpcOutputChannel implements OutputChannel {
  private wc: WebContents;

  constructor(wc: WebContents) {
    this.wc = wc;
  }

  text(content: string): void {
    this.wc.send("output:text", { content });
  }

  streamToken(token: string): void {
    this.wc.send("output:stream-token", { token });
  }

  streamThinking(token: string): void {
    this.wc.send("output:stream-thinking", { token });
  }

  endThinking(): void {
    this.wc.send("output:end-thinking");
  }

  toolCall(info: ToolCallInfo): void {
    this.wc.send("output:tool-call", info);
  }

  toolResult(name: string, ok: boolean, summary?: string): void {
    this.wc.send("output:tool-result", { name, ok, summary });
  }

  error(message: string): void {
    this.wc.send("output:error", { message });
  }

  warn(message: string): void {
    this.wc.send("output:warn", { message });
  }

  system(message: string): void {
    this.wc.send("output:system", { message });
  }

  success(message: string): void {
    this.wc.send("output:success", { message });
  }

  dim(message: string): void {
    this.wc.send("output:dim", { message });
  }

  usage(info: UsageDisplayInfo): void {
    this.wc.send("output:usage", info);
  }

  /**
   * 通知渲染进程显示模型请求等待状态
   * @returns {void}
   */
  startLoading(): void {
    this.wc.send("output:start-loading");
  }

  /**
   * 通知渲染进程收起模型请求等待状态
   * @returns {void}
   */
  stopLoading(): void {
    this.wc.send("output:stop-loading");
  }

  ensureNewline(): void {
    // IPC 版本无需处理
  }
}
```

#### Step 2: 创建 ipc-input.ts

```typescript
import type { InputChannel, InputRequest } from "@tx-cli/core";
import type { WebContents } from "electron";

/**
 * 桌面版输入通道：通过 IPC 等待渲染进程的用户输入
 */
export class IpcInputChannel implements InputChannel {
  private wc: WebContents;
  private pendingResolve: ((value: string) => void) | null = null;

  constructor(wc: WebContents) {
    this.wc = wc;
  }

  /**
   * 请求渲染进程采集一行输入
   * @param {string | InputRequest} [request] - 提示文案或完整输入请求
   * @returns {Promise<string>} 用户提交的文本
   */
  async readLine(request?: string | InputRequest): Promise<string> {
    const inputRequest: InputRequest = typeof request === "string"
      ? { message: request }
      : request ?? { message: "" };
    this.wc.send("input:request", {
      message: inputRequest.message,
      initialInput: inputRequest.initialInput,
    });
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  /** 由 IPC handler 调用：用户提交了输入 */
  resolveInput(text: string): void {
    this.pendingResolve?.(text);
    this.pendingResolve = null;
  }

  /**
   * 桌面 GUI 会话始终支持交互
   * @returns {boolean} 固定为 true
   */
  isInteractive(): boolean {
    return true;
  }

  close(): void {
    this.pendingResolve = null;
  }
}
```

`InputRequest.suggest` 回调、`history` 数组引用和 `signal` 不可直接通过 IPC 结构化克隆；只在事件中传递可序列化字段，补全结果、输入历史和中断由主进程会话服务协调。

#### Step 3: 创建 ipc-prompt.ts

```typescript
import type { PromptChannel } from "@tx-cli/core";
import type { WebContents } from "electron";

/**
 * 桌面版交互提示通道：通过 IPC 发送确认/选择/输入请求
 */
export class IpcPromptChannel implements PromptChannel {
  private wc: WebContents;
  private pendingPrompts = new Map<string, (value: unknown) => void>();

  constructor(wc: WebContents) {
    this.wc = wc;
  }

  /**
   * 请求用户确认
   * @param {string} message - 提示信息
   * @param {boolean} [initial] - 默认选项
   * @returns {Promise<boolean>} 用户确认结果
   */
  async confirm(message: string, initial = false): Promise<boolean> {
    const id = crypto.randomUUID();
    this.wc.send("prompt:confirm", { id, message, initial });
    return new Promise((resolve) => {
      this.pendingPrompts.set(id, (value) => resolve(value as boolean));
    });
  }

  /**
   * 请求用户从泛型选项中选择一项
   * @param {string} message - 提示信息
   * @param {Array<{ title: string; value: T }>} choices - 展示标题与回传值
   * @returns {Promise<T>} 选中项的 value
   */
  async select<T = string>(
    message: string,
    choices: Array<{ title: string; value: T }>,
  ): Promise<T> {
    const id = crypto.randomUUID();
    this.wc.send("prompt:select", { id, message, choices });
    return new Promise((resolve) => {
      this.pendingPrompts.set(id, (value) => resolve(value as T));
    });
  }

  /**
   * 请求用户输入自由文本
   * @param {string} message - 提示信息
   * @param {string} [defaultValue] - 默认输入
   * @returns {Promise<string>} 用户输入文本
   */
  async input(message: string, defaultValue?: string): Promise<string> {
    const id = crypto.randomUUID();
    this.wc.send("prompt:input", { id, message, defaultValue });
    return new Promise((resolve) => {
      this.pendingPrompts.set(id, (value) => resolve(value as string));
    });
  }

  /**
   * 由 IPC handler 调用：路由确认、选择或输入响应
   * @param {string} id - 请求标识
   * @param {unknown} value - 用户响应值
   * @returns {void}
   */
  resolvePrompt(id: string, value: unknown): void {
    const resolve = this.pendingPrompts.get(id);
    if (resolve) {
      resolve(value);
      this.pendingPrompts.delete(id);
    }
  }
}
```

选择项以 `title` 展示、以 `value` 回传；当 `T` 为自定义对象时，其值必须支持 Electron IPC 结构化克隆，不能携带函数等不可序列化内容。

### 验收标准

- [ ] 三个 IPC Channel 类实现完整
- [ ] `pnpm --filter @tx-cli/desktop type-check` 通过

---

## Task 5.3: 主进程 IPC Handler

### 目标

实现主进程的 IPC 消息路由和会话管理。

### 涉及文件

- `packages/desktop/src/main/index.ts` — 新建
- `packages/desktop/src/main/window.ts` — 新建
- `packages/desktop/src/main/session-service.ts` — 新建
- `packages/desktop/src/main/ipc-handlers.ts` — 新建

### 步骤

#### Step 1: 创建 window.ts

```typescript
import { BrowserWindow } from "electron";
import { resolve } from "node:path";

/**
 * 创建主窗口
 */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "tx-cli Desktop",
    webPreferences: {
      preload: resolve(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(resolve(__dirname, "../renderer/index.html"));
  }

  return win;
}
```

#### Step 2: 创建 session-service.ts 管理多轮会话

新增 `DesktopSessionService`，按窗口与 `sessionId` 隔离桌面会话。每个桌面会话持有一个 core `ConversationSession` 和三个 IPC Channel，桌面服务只负责输入/提示响应路由、GUI 生命周期与 core API 委托。

- 首次创建会话时加载 LLM 配置，按 Agent/Chat 模式创建 core `ConversationSession` 并注入 IPC Channel；同一对象在后续回合复用，不在每条消息结束后释放。
- 每次发送消息调用该对象的串行 `runTurn`。runtime、history、子 Agent、压缩、用量、取消回滚与 dispose 均由 core 统一实现，桌面端不得直接拼接一套 `executeConversationTurn` 控制逻辑。
- 删除会话、窗口销毁或应用退出时调用 `ConversationSession.dispose`；切换 Provider/Model 或模式需要重建配置时，先释放旧会话，再创建新会话。

不得通过每条消息调用一次 `runOneShotConversation` 来模拟多轮，也不迁入终端 REPL 主循环。桌面服务只编排 GUI 会话与 core 无头多轮会话之间的映射。

#### Step 3: 创建 ipc-handlers.ts

```typescript
import { ipcMain } from "electron";
import { DesktopSessionService } from "./session-service";

const sessionService = new DesktopSessionService();

/**
 * 注册所有 IPC 处理器
 * @returns {void}
 */
export function registerIpcHandlers(): void {
  // 发送消息（Agent/Chat），由会话服务复用同一 runtime/history 执行本轮
  ipcMain.handle("chat:send", async (event, { sessionId = "default", text, mode, provider, model }) => {
    await sessionService.sendTurn(event.sender, { sessionId, text, mode, provider, model });
  });

  // 路由桌面输入响应
  ipcMain.on("input:response", (event, { text }) => {
    sessionService.resolveInput(event.sender, text);
  });

  // 路由确认、泛型选择和自由输入响应
  ipcMain.on("prompt:response", (event, { id, value }) => {
    sessionService.resolvePrompt(event.sender, id, value);
  });

  // 取消当前会话的本轮执行
  ipcMain.on("chat:cancel", (event, { sessionId = "default" } = {}) => {
    sessionService.cancelTurn(event.sender, sessionId);
  });

  // 切换模型，由会话服务决定是否需要重建 runtime
  ipcMain.on("chat:switch-model", (event, { sessionId = "default", provider, model }) => {
    sessionService.switchModel(event.sender, { sessionId, provider, model });
  });
}
```

#### Step 4: 创建主进程入口 index.ts

```typescript
import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window";
import { registerIpcHandlers } from "./ipc-handlers";

app.whenReady().then(() => {
  registerIpcHandlers();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
```

### 验收标准

- [ ] 主进程能创建窗口
- [ ] IPC 处理器注册成功
- [ ] 同一 `sessionId` 连续发送消息时复用同一 core `ConversationSession`，能够引用前序上下文，不同会话的历史互不影响
- [ ] 会话删除、窗口销毁和应用退出时释放 runtime，取消本轮不会留下未配对历史
- [ ] `pnpm --filter @tx-cli/desktop dev` 能启动应用

---

## Task 5.4: Preload 安全桥接

### 目标

通过 contextBridge 暴露安全的 API 给渲染进程。

### 涉及文件

- `packages/desktop/src/preload/index.ts` — 新建

### 步骤

#### Step 1: 创建 preload/index.ts

```typescript
import { contextBridge, ipcRenderer } from "electron";

/** 暴露给渲染进程的 API */
const api = {
  /** 发送消息 */
  sendMessage: (text: string, mode: "agent" | "chat", provider?: string, model?: string) => {
    return ipcRenderer.invoke("chat:send", { text, mode, provider, model });
  },

  /**
   * 返回桌面输入结果
   * @param {string} text - 用户提交的文本
   * @returns {void}
   */
  inputResponse: (text: string) => {
    ipcRenderer.send("input:response", { text });
  },

  /**
   * 返回确认、选择或自由输入结果
   * @param {string} id - 请求标识
   * @param {unknown} value - 布尔结果、选中项 value 或输入文本
   * @returns {void}
   */
  promptResponse: (id: string, value: unknown) => {
    ipcRenderer.send("prompt:response", { id, value });
  },

  /** 取消 */
  cancel: () => {
    ipcRenderer.send("chat:cancel");
  },

  /** 切换模型 */
  switchModel: (provider: string, model: string) => {
    ipcRenderer.send("chat:switch-model", { provider, model });
  },

  /** 监听输出事件 */
  onOutput: (channel: string, callback: (...args: any[]) => void) => {
    const validChannels = [
      "output:text", "output:stream-token", "output:stream-thinking",
      "output:end-thinking", "output:tool-call", "output:tool-result",
      "output:error", "output:warn", "output:system", "output:success",
      "output:dim", "output:usage", "output:start-loading", "output:stop-loading",
      "input:request", "prompt:confirm", "prompt:select", "prompt:input",
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },

  /** 移除监听 */
  removeListener: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
};

contextBridge.exposeInMainWorld("txCli", api);

/** 类型声明（供渲染进程使用） */
export type TxCliApi = typeof api;
```

### 验收标准

- [ ] contextBridge 正确暴露 API
- [ ] 渲染进程能通过 `window.txCli` 调用

---

## Task 5.5: React UI — 布局与组件

### 目标

实现桌面端的聊天界面。

### 涉及文件

- `packages/desktop/src/renderer/main.tsx` — 新建
- `packages/desktop/src/renderer/App.tsx` — 新建
- `packages/desktop/src/renderer/components/` — 新建多个组件

### 步骤

#### Step 1: 创建 main.tsx

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

#### Step 2: 创建 App.tsx

```tsx
import React from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatWindow } from "./components/ChatWindow";

export default function App() {
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <Sidebar />
      <ChatWindow />
    </div>
  );
}
```

#### Step 3: 创建核心组件

需要创建以下组件：

**ChatWindow.tsx** — 聊天窗口（包含消息列表 + 输入框 + 工具栏）
```
┌─────────────────────────────────────────┐
│  ┌───────┐ ┌──────────┐ ┌────────────┐ │
│  │Agent/Chat│ │模型选择   │ │思考档位    │ │
│  └───────┘ └──────────┘ └────────────┘ │
│ ───────────────────────────────────────│
│  MessageList                            │
│  ┌─────────────────────────────────┐   │
│  │ 用户消息                         │   │
│  │ AI 回复（Markdown 渲染）          │   │
│  │ ToolCallCard（工具调用展示）       │   │
│  └─────────────────────────────────┘   │
│ ───────────────────────────────────────│
│  ┌────────────────────────┐ ┌────────┐ │
│  │ MessageInput           │ │ 发送   │ │
│  └────────────────────────┘ └────────┘ │
└─────────────────────────────────────────┘
```

**MessageList.tsx** — 消息列表，支持：
- 用户/AI 消息气泡
- Markdown 渲染（代码高亮）
- 流式输出（逐字显示）
- 工具调用卡片展示

**MessageInput.tsx** — 输入框，支持：
- 多行输入
- Enter 发送 / Shift+Enter 换行
- 取消按钮

**ModeSelector.tsx** — Agent/Chat 模式切换

**ModelSelector.tsx** — Provider/Model 选择

**ThinkingLevelSelector.tsx** — 思考档位选择（off/low/medium/high）

**ToolCallCard.tsx** — 工具调用展示卡片，支持：
- 工具名称和参数
- 执行状态（进行中/成功/失败）
- 结果展示（可折叠）

**Sidebar.tsx** — 侧边栏，包含：
- 会话列表
- 新建会话按钮
- 设置入口

### 验收标准

- [ ] 所有组件创建完成
- [ ] 界面布局正确
- [ ] 能正常显示消息

---

## Task 5.6: 状态管理与 Hooks

### 目标

使用 zustand 管理聊天状态，实现自定义 hooks。

### 涉及文件

- `packages/desktop/src/renderer/stores/chat-store.ts` — 新建
- `packages/desktop/src/renderer/hooks/useChat.ts` — 新建
- `packages/desktop/src/renderer/hooks/useSession.ts` — 新建

### 步骤

#### Step 1: 创建 chat-store.ts

```typescript
import { create } from "zustand";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
}

interface ChatState {
  messages: Message[];
  isStreaming: boolean;
  mode: "agent" | "chat";
  provider: string;
  model: string;
  thinkingLevel: "off" | "low" | "medium" | "high";

  addMessage: (msg: Message) => void;
  appendToken: (token: string) => void;
  appendThinking: (token: string) => void;
  setStreaming: (streaming: boolean) => void;
  setMode: (mode: "agent" | "chat") => void;
  setModel: (provider: string, model: string) => void;
  setThinkingLevel: (level: "off" | "low" | "medium" | "high") => void;
  clearMessages: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isStreaming: false,
  mode: "chat",
  provider: "",
  model: "",
  thinkingLevel: "low",

  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  appendToken: (token) => set((s) => {
    const last = s.messages[s.messages.length - 1];
    if (last?.role === "assistant") {
      last.content += token;
      return { messages: [...s.messages] };
    }
    return { messages: [...s.messages, { id: crypto.randomUUID(), role: "assistant", content: token, timestamp: Date.now() }] };
  }),
  // ... 其他方法
}));
```

#### Step 2: 创建 useChat.ts

```typescript
import { useEffect, useCallback } from "react";
import { useChatStore } from "../stores/chat-store";

/**
 * 聊天逻辑 Hook
 * 监听 IPC 输出事件，更新 store
 */
export function useChat() {
  const store = useChatStore();

  useEffect(() => {
    // 监听流式 token
    window.txCli.onOutput("output:stream-token", ({ token }) => {
      store.appendToken(token);
    });

    // 监听思考 token
    window.txCli.onOutput("output:stream-thinking", ({ token }) => {
      store.appendThinking(token);
    });

    // 监听工具调用
    window.txCli.onOutput("output:tool-call", (info) => {
      // TODO: 处理工具调用展示
    });

    // 监听错误
    window.txCli.onOutput("output:error", ({ message }) => {
      // TODO: 处理错误展示
    });

    return () => {
      // 清理监听
      window.txCli.removeListener("output:stream-token");
      window.txCli.removeListener("output:stream-thinking");
      // ...
    };
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    store.addMessage({ id: crypto.randomUUID(), role: "user", content: text, timestamp: Date.now() });
    store.setStreaming(true);
    await window.txCli.sendMessage(text, store.mode, store.provider, store.model);
    store.setStreaming(false);
  }, [store.mode, store.provider, store.model]);

  return { sendMessage };
}
```

### 验收标准

- [ ] zustand store 正常工作
- [ ] IPC 事件能正确更新 UI
- [ ] 消息能正常发送和接收

---

## Task 5.7: 会话持久化

### 目标

将聊天历史持久化到本地存储。

### 涉及文件

- `packages/desktop/src/renderer/stores/chat-store.ts` — 修改（添加持久化）

### 步骤

#### Step 1: 使用 zustand persist 中间件

```typescript
import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      // ... 现有状态和方法
    }),
    {
      name: "tx-cli-chat-storage",
      partialize: (state) => ({
        messages: state.messages,
        mode: state.mode,
        provider: state.provider,
        model: state.model,
        thinkingLevel: state.thinkingLevel,
      }),
    }
  )
);
```

### 验收标准

- [ ] 刷新页面后聊天历史保留
- [ ] 模式/模型选择保留

---

## Task 5.8: 打包与测试

### 目标

配置 electron-builder，支持打包为各平台安装包。

### 涉及文件

- `packages/desktop/electron-builder.yml` — 新建

### 步骤

#### Step 1: 创建 electron-builder.yml

```yaml
appId: com.txcli.desktop
productName: tx-cli Desktop
directories:
  output: release
files:
  - dist/**
  - node_modules/**
mac:
  category: public.app-category.developer-tools
  target:
    - dmg
    - zip
win:
  target:
    - nsis
    - portable
linux:
  target:
    - AppImage
    - deb
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
```

#### Step 2: 添加打包脚本

在 `packages/desktop/package.json` 中添加：

```json
{
  "scripts": {
    "pack": "electron-vite build && electron-builder --dir",
    "dist": "electron-vite build && electron-builder"
  }
}
```

#### Step 3: 测试打包

```bash
pnpm --filter @tx-cli/desktop dist
```

### 验收标准

- [ ] macOS 打包成功（.dmg）
- [ ] Windows 打包成功（.exe）
- [ ] Linux 打包成功（.AppImage）
- [ ] 打包后的应用能正常运行
- [ ] `desktop` 的 workspace 依赖仅限 `@tx-cli/core`、`@tx-cli/shared`，不依赖 `@tx-cli/cli`，也不导入 core/CLI 的终端 REPL、输入帧或面板
- [ ] core 经 Channel 与 IPC 发往渲染进程的文本、工具调用和错误消息不含 ANSI 控制字符，颜色与样式完全由 React UI 处理
