# Phase 5: 云端 Agent 服务

> 前置依赖：Phase 3 完成
> 预计产出：可部署在云服务器上的 Agent 服务，支持浏览器访问、多用户、实时对话

## 概述

基于 Express + WebSocket + React 构建云端服务，复用 `@tx-cli/core` 包，通过 WebSocket Channel 与浏览器通信。

**核心原则：多用户、JWT 认证、目录隔离、WebSocket 实时通信。**

---

## Task 5.1: 搭建服务项目骨架

### 目标

初始化 `packages/server/` 项目。

### 涉及文件

- `packages/server/package.json` — 新建
- `packages/server/tsconfig.json` — 新建

### 步骤

#### Step 1: 创建 packages/server/package.json

```json
{
  "name": "@tx-cli/server",
  "version": "0.11.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "dev": "tsx watch ./src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node ./dist/index.js",
    "type-check": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@tx-cli/core": "workspace:*",
    "@tx-cli/shared": "workspace:*",
    "express": "^5.0.0",
    "ws": "^8.18.0",
    "jsonwebtoken": "^9.0.0",
    "bcryptjs": "^3.0.0",
    "cors": "^2.8.5",
    "nanoid": "^5.0.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/ws": "^8.18.0",
    "@types/jsonwebtoken": "^9.0.0",
    "@types/cors": "^2.8.5",
    "@types/node": "^26.4.1",
    "tsx": "^4.23.13",
    "typescript": "5.9.2"
  }
}
```

#### Step 2: 创建 packages/server/tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"],
    "paths": {
      "@tx-cli/core": ["../core/src/index.ts"],
      "@tx-cli/shared": ["../shared/src/index.ts"]
    }
  },
  "include": ["./src/**/*"]
}
```

#### Step 3: 创建目录结构

```bash
mkdir -p packages/server/src/{routes,ws,middleware,services,channels}
mkdir -p packages/server/web/src/{pages,components,hooks,api}
```

### 验收标准

- [ ] 项目结构完整
- [ ] `pnpm --filter @tx-cli/server type-check` 通过

---

## Task 5.2: 用户系统

### 目标

实现用户模型、存储和密码加密。

### 涉及文件

- `packages/server/src/services/user-service.ts` — 新建
- `packages/server/src/config.ts` — 新建

### 步骤

#### Step 1: 创建 config.ts

```typescript
import { resolve } from "node:path";

/** 服务配置 */
export const config = {
  /** 服务端口 */
  port: Number(process.env.TX_CLI_PORT) || 3000,
  /** 数据目录 */
  dataDir: resolve(process.env.TX_CLI_DATA_DIR || "./data"),
  /** JWT 密钥 */
  jwtSecret: process.env.TX_CLI_JWT_SECRET || "change-me-in-production",
  /** JWT 过期时间 */
  jwtExpiresIn: "7d",
  /** 用户数据文件 */
  usersFile: resolve(process.env.TX_CLI_DATA_DIR || "./data", "users.json"),
};
```

#### Step 2: 创建 user-service.ts

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import bcrypt from "bcryptjs";
import { config } from "../config";

/** 用户角色 */
export type UserRole = "admin" | "user";

/** 用户信息 */
export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
}

/** 用户存储 */
interface UserStore {
  users: User[];
}

/**
 * 用户服务：管理用户的增删改查
 * 数据存储在 JSON 文件中
 */
export class UserService {
  private store: UserStore;

  constructor() {
    this.store = this.load();
  }

  /** 从文件加载用户数据 */
  private load(): UserStore {
    if (!existsSync(config.usersFile)) {
      return { users: [] };
    }
    const raw = readFileSync(config.usersFile, "utf-8");
    return JSON.parse(raw);
  }

  /** 保存用户数据到文件 */
  private save(): void {
    mkdirSync(dirname(config.usersFile), { recursive: true });
    writeFileSync(config.usersFile, JSON.stringify(this.store, null, 2), { mode: 0o600 });
  }

  /** 创建用户 */
  async createUser(username: string, password: string, role: UserRole = "user"): Promise<User> {
    if (this.store.users.find((u) => u.username === username)) {
      throw new Error(`用户 "${username}" 已存在`);
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user: User = {
      id: crypto.randomUUID(),
      username,
      passwordHash,
      role,
      createdAt: new Date().toISOString(),
    };
    this.store.users.push(user);
    this.save();
    return user;
  }

  /** 验证用户密码 */
  async verifyPassword(username: string, password: string): Promise<User | null> {
    const user = this.store.users.find((u) => u.username === username);
    if (!user) return null;
    const valid = await bcrypt.compare(password, user.passwordHash);
    return valid ? user : null;
  }

  /** 按 ID 查找用户 */
  findById(id: string): User | undefined {
    return this.store.users.find((u) => u.id === id);
  }

  /** 按用户名查找用户 */
  findByUsername(username: string): User | undefined {
    return this.store.users.find((u) => u.username === username);
  }

  /** 列出所有用户 */
  listUsers(): Omit<User, "passwordHash">[] {
    return this.store.users.map(({ passwordHash, ...rest }) => rest);
  }

  /** 删除用户 */
  deleteUser(username: string): boolean {
    const index = this.store.users.findIndex((u) => u.username === username);
    if (index === -1) return false;
    this.store.users.splice(index, 1);
    this.save();
    return true;
  }
}
```

### 验收标准

- [ ] 用户创建、验证、删除功能正常
- [ ] 密码加密存储（bcrypt）
- [ ] 用户数据文件权限为 0600

---

## Task 5.3: 认证系统

### 目标

实现 JWT 签发与验证、认证中间件。

### 涉及文件

- `packages/server/src/services/auth-service.ts` — 新建
- `packages/server/src/middleware/auth.ts` — 新建
- `packages/server/src/routes/auth.ts` — 新建

### 步骤

#### Step 1: 创建 auth-service.ts

```typescript
import jwt from "jsonwebtoken";
import { config } from "../config";
import type { User } from "./user-service";

/** JWT Payload */
export interface JwtPayload {
  userId: string;
  username: string;
  role: string;
}

/**
 * 认证服务：JWT 签发与验证
 */
export class AuthService {
  /** 签发 JWT */
  sign(user: User): string {
    const payload: JwtPayload = {
      userId: user.id,
      username: user.username,
      role: user.role,
    };
    return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
  }

  /** 验证 JWT */
  verify(token: string): JwtPayload | null {
    try {
      return jwt.verify(token, config.jwtSecret) as JwtPayload;
    } catch {
      return null;
    }
  }
}
```

#### Step 2: 创建 middleware/auth.ts

```typescript
import type { Request, Response, NextFunction } from "express";
import { AuthService } from "../services/auth-service";

const authService = new AuthService();

/** 扩展 Request 类型 */
declare global {
  namespace Express {
    interface Request {
      user?: { userId: string; username: string; role: string };
    }
  }
}

/**
 * JWT 认证中间件
 * 从 Authorization: Bearer <token> 头中提取并验证 JWT
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "未提供认证 Token" });
    return;
  }
  const token = header.slice(7);
  const payload = authService.verify(token);
  if (!payload) {
    res.status(401).json({ error: "Token 无效或已过期" });
    return;
  }
  req.user = payload;
  next();
}
```

#### Step 3: 创建 routes/auth.ts

```typescript
import { Router } from "express";
import { UserService } from "../services/user-service";
import { AuthService } from "../services/auth-service";

const userService = new UserService();
const authService = new AuthService();

export const authRouter = Router();

/** POST /api/auth/login — 登录 */
authRouter.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: "用户名和密码不能为空" });
    return;
  }
  const user = await userService.verifyPassword(username, password);
  if (!user) {
    res.status(401).json({ error: "用户名或密码错误" });
    return;
  }
  const token = authService.sign(user);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

/** POST /api/auth/refresh — 刷新 Token */
authRouter.post("/refresh", (req, res) => {
  // TODO: 实现 Token 刷新
  res.status(501).json({ error: "未实现" });
});
```

### 验收标准

- [ ] 登录 API 能正确签发 JWT
- [ ] 认证中间件能正确验证 JWT
- [ ] 无效 Token 返回 401

---

## Task 5.4: 用户管理 CLI

### 目标

提供服务端用户管理命令，仅通过 CLI 操作。

### 涉及文件

- `packages/server/src/cli.ts` — 新建（独立 CLI 入口）

### 步骤

#### Step 1: 创建用户管理 CLI

```typescript
#!/usr/bin/env node
/**
 * tx-cli-server 用户管理 CLI
 * 仅在云服务器上通过命令行操作，不暴露 Web 注册
 */
import { Command } from "commander";
import { UserService } from "./services/user-service";

const program = new Command();
const userService = new UserService();

program
  .name("tx-cli-server")
  .description("tx-cli 云端服务管理工具");

program
  .command("user")
  .description("用户管理");

program
  .command("user:add")
  .description("添加用户")
  .requiredOption("--name <username>", "用户名")
  .requiredOption("--password <password>", "密码")
  .option("--role <role>", "角色", "user")
  .action(async (options) => {
    const user = await userService.createUser(options.name, options.password, options.role);
    console.log(`用户 "${user.username}" 创建成功（ID: ${user.id}）`);
  });

program
  .command("user:list")
  .description("列出所有用户")
  .action(() => {
    const users = userService.listUsers();
    console.table(users);
  });

program
  .command("user:remove")
  .description("删除用户")
  .requiredOption("--name <username>", "用户名")
  .action((options) => {
    const removed = userService.deleteUser(options.name);
    console.log(removed ? `用户 "${options.name}" 已删除` : `用户 "${options.name}" 不存在`);
  });

program.parse();
```

#### Step 2: 添加 bin 配置

在 `packages/server/package.json` 中添加：

```json
{
  "bin": {
    "tx-cli-server": "./src/cli.ts"
  }
}
```

### 验收标准

- [ ] `tx-cli-server user:add --name alice --password xxx` 能创建用户
- [ ] `tx-cli-server user:list` 能列出用户
- [ ] `tx-cli-server user:remove --name alice` 能删除用户

---

## Task 5.5: 实现云端版 Channel

### 目标

实现 WebSocket 版本的 Channel 接口。

### 涉及文件

- `packages/server/src/channels/ws-output.ts` — 新建
- `packages/server/src/channels/ws-input.ts` — 新建
- `packages/server/src/channels/ws-prompt.ts` — 新建

### 步骤

#### Step 1: 创建 ws-output.ts

```typescript
import type { OutputChannel, ToolCallInfo, UsageDisplayInfo } from "@tx-cli/core";
import type { WebSocket } from "ws";

/**
 * 云端版输出通道：通过 WebSocket 推送消息
 */
export class WsOutputChannel implements OutputChannel {
  private ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  private send(type: string, data: any): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify({ type, ...data }));
    }
  }

  text(content: string): void { this.send("text", { content }); }
  streamToken(token: string): void { this.send("stream-token", { token }); }
  streamThinking(token: string): void { this.send("stream-thinking", { token }); }
  endThinking(): void { this.send("end-thinking", {}); }
  toolCall(info: ToolCallInfo): void { this.send("tool-call", info); }
  toolResult(name: string, ok: boolean, summary?: string): void {
    this.send("tool-result", { name, ok, summary });
  }
  error(message: string): void { this.send("error", { message }); }
  warn(message: string): void { this.send("warn", { message }); }
  system(message: string): void { this.send("system", { message }); }
  success(message: string): void { this.send("success", { message }); }
  dim(message: string): void { this.send("dim", { message }); }
  usage(info: UsageDisplayInfo): void { this.send("usage", info); }
  ensureNewline(): void { /* WebSocket 无需处理 */ }
}
```

#### Step 2: 创建 ws-input.ts

```typescript
import type { InputChannel } from "@tx-cli/core";
import type { WebSocket } from "ws";

/**
 * 云端版输入通道：通过 WebSocket 接收用户输入
 */
export class WsInputChannel implements InputChannel {
  private ws: WebSocket;
  private pendingResolve: ((value: string) => void) | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  async readLine(prompt?: string): Promise<string> {
    this.ws.send(JSON.stringify({ type: "input-request", prompt }));
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  /** 由 WebSocket handler 调用：用户提交了输入 */
  resolveInput(text: string): void {
    this.pendingResolve?.(text);
    this.pendingResolve = null;
  }

  close(): void {
    this.pendingResolve = null;
  }
}
```

#### Step 3: 创建 ws-prompt.ts

```typescript
import type { PromptChannel } from "@tx-cli/core";
import type { WebSocket } from "ws";

/**
 * 云端版交互提示通道：通过 WebSocket 发送确认/选择/输入请求
 */
export class WsPromptChannel implements PromptChannel {
  private ws: WebSocket;
  private pending = new Map<string, (value: any) => void>();

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  async confirm(message: string): Promise<boolean> {
    const id = crypto.randomUUID();
    this.ws.send(JSON.stringify({ type: "prompt-confirm", id, message }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async select(message: string, choices: Array<{ label: string; value: string }>): Promise<string> {
    const id = crypto.randomUUID();
    this.ws.send(JSON.stringify({ type: "prompt-select", id, message, choices }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async input(message: string, defaultValue?: string): Promise<string> {
    const id = crypto.randomUUID();
    this.ws.send(JSON.stringify({ type: "prompt-input", id, message, defaultValue }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  /** 由 WebSocket handler 调用：用户响应了确认 */
  resolve(id: string, value: any): void {
    const resolve = this.pending.get(id);
    if (resolve) {
      resolve(value);
      this.pending.delete(id);
    }
  }
}
```

### 验收标准

- [ ] 三个 WebSocket Channel 实现完整
- [ ] `pnpm --filter @tx-cli/server type-check` 通过

---

## Task 5.6: WebSocket 服务

### 目标

实现 WebSocket 连接管理和会话池。

### 涉及文件

- `packages/server/src/ws/handler.ts` — 新建
- `packages/server/src/services/session-pool.ts` — 新建

### 步骤

#### Step 1: 创建 session-pool.ts

```typescript
import type { WebSocket } from "ws";
import { WsOutputChannel } from "../channels/ws-output";
import { WsInputChannel } from "../channels/ws-input";
import { WsPromptChannel } from "../channels/ws-prompt";

/** 会话信息 */
export interface Session {
  id: string;
  userId: string;
  ws: WebSocket;
  channels: {
    output: WsOutputChannel;
    input: WsInputChannel;
    prompt: WsPromptChannel;
  };
  createdAt: Date;
}

/**
 * 会话池：管理所有活跃的 WebSocket 会话
 */
export class SessionPool {
  private sessions = new Map<string, Session>();

  /** 创建新会话 */
  create(userId: string, ws: WebSocket): Session {
    const id = crypto.randomUUID();
    const session: Session = {
      id,
      userId,
      ws,
      channels: {
        output: new WsOutputChannel(ws),
        input: new WsInputChannel(ws),
        prompt: new WsPromptChannel(ws),
      },
      createdAt: new Date(),
    };
    this.sessions.set(id, session);
    return session;
  }

  /** 获取会话 */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** 关闭会话 */
  close(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.channels.input.close();
      this.sessions.delete(id);
    }
  }

  /** 获取用户的所有会话 */
  getByUser(userId: string): Session[] {
    return Array.from(this.sessions.values()).filter((s) => s.userId === userId);
  }
}
```

#### Step 2: 创建 ws/handler.ts

```typescript
import type { WebSocketServer, WebSocket } from "ws";
import { AuthService } from "../services/auth-service";
import { SessionPool } from "../services/session-pool";
import { runOneShotConversation } from "@tx-cli/core";

const authService = new AuthService();
const sessionPool = new SessionPool();

/**
 * WebSocket 连接处理器
 */
export function handleConnection(wss: WebSocketServer): void {
  wss.on("connection", (ws: WebSocket, req) => {
    // 从 URL 参数中获取 token
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) {
      ws.close(4001, "未提供认证 Token");
      return;
    }

    const payload = authService.verify(token);
    if (!payload) {
      ws.close(4001, "Token 无效或已过期");
      return;
    }

    const session = sessionPool.create(payload.userId, ws);
    ws.send(JSON.stringify({ type: "session-created", sessionId: session.id }));

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await handleMessage(session.id, msg);
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: "消息格式错误" }));
      }
    });

    ws.on("close", () => {
      sessionPool.close(session.id);
    });
  });
}

/**
 * 处理 WebSocket 消息
 */
async function handleMessage(sessionId: string, msg: any): Promise<void> {
  const session = sessionPool.get(sessionId);
  if (!session) return;

  switch (msg.type) {
    case "chat":
      // 处理聊天消息
      await runOneShotConversation({
        // ... 配置
        channels: session.channels,
        userInput: msg.text,
      });
      break;
    case "confirm":
      session.channels.prompt.resolve(msg.id, msg.approved);
      break;
    case "input":
      session.channels.input.resolveInput(msg.text);
      break;
    case "cancel":
      // TODO: 取消当前会话
      break;
  }
}
```

### 验收标准

- [ ] WebSocket 连接能正确认证
- [ ] 会话能正常创建和销毁
- [ ] 消息能正确路由

---

## Task 5.7: HTTP API

### 目标

实现 RESTful API 路由。

### 涉及文件

- `packages/server/src/routes/models.ts` — 新建
- `packages/server/src/routes/sessions.ts` — 新建
- `packages/server/src/routes/users.ts` — 新建
- `packages/server/src/app.ts` — 新建

### 步骤

#### Step 1: 创建 routes/models.ts

```typescript
import { Router } from "express";
import { authMiddleware } from "../middleware/auth";

export const modelsRouter = Router();
modelsRouter.use(authMiddleware);

/** GET /api/models — 获取可用模型列表 */
modelsRouter.get("/", (req, res) => {
  // TODO: 从 ProviderRegistry 获取模型列表
  res.json({ models: [] });
});
```

#### Step 2: 创建 routes/sessions.ts

```typescript
import { Router } from "express";
import { authMiddleware } from "../middleware/auth";

export const sessionsRouter = Router();
sessionsRouter.use(authMiddleware);

/** GET /api/sessions — 获取当前用户会话列表 */
sessionsRouter.get("/", (req, res) => {
  // TODO: 返回当前用户的会话列表
  res.json({ sessions: [] });
});

/** POST /api/sessions — 创建新会话 */
sessionsRouter.post("/", (req, res) => {
  // TODO: 创建新会话
  res.json({ sessionId: "new-session-id" });
});

/** DELETE /api/sessions/:id — 删除会话 */
sessionsRouter.delete("/:id", (req, res) => {
  // TODO: 删除会话
  res.json({ ok: true });
});
```

#### Step 3: 创建 routes/users.ts

```typescript
import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { UserService } from "../services/user-service";

const userService = new UserService();
export const usersRouter = Router();
usersRouter.use(authMiddleware);

/** GET /api/users/me — 获取当前用户信息 */
usersRouter.get("/me", (req, res) => {
  const user = userService.findById(req.user!.userId);
  if (!user) {
    res.status(404).json({ error: "用户不存在" });
    return;
  }
  const { passwordHash, ...safeUser } = user;
  res.json(safeUser);
});

/** POST /api/users — 创建用户（仅管理员） */
usersRouter.post("/", async (req, res) => {
  if (req.user!.role !== "admin") {
    res.status(403).json({ error: "仅管理员可创建用户" });
    return;
  }
  const { username, password, role } = req.body;
  try {
    const user = await userService.createUser(username, password, role);
    const { passwordHash, ...safeUser } = user;
    res.status(201).json(safeUser);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
```

#### Step 4: 创建 app.ts

```typescript
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { authRouter } from "./routes/auth";
import { modelsRouter } from "./routes/models";
import { sessionsRouter } from "./routes/sessions";
import { usersRouter } from "./routes/users";
import { handleConnection } from "./ws/handler";
import { config } from "./config";

/** 创建 Express 应用 */
export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // API 路由
  app.use("/api/auth", authRouter);
  app.use("/api/models", modelsRouter);
  app.use("/api/sessions", sessionsRouter);
  app.use("/api/users", usersRouter);

  // 静态文件（前端页面）
  app.use(express.static("web/dist"));

  // 创建 HTTP 服务器
  const server = createServer(app);

  // 创建 WebSocket 服务器
  const wss = new WebSocketServer({ server, path: "/ws" });
  handleConnection(wss);

  return { app, server, wss };
}
```

### 验收标准

- [ ] 所有 API 路由正常工作
- [ ] 认证中间件正确拦截未认证请求
- [ ] WebSocket 能正常连接

---

## Task 5.8: 目录隔离

### 目标

每个用户的 agent 会话被限制在自己的工作目录内。

### 涉及文件

- `packages/server/src/services/workspace.ts` — 新建

### 步骤

#### Step 1: 创建 workspace.ts

```typescript
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { config } from "../config";

/**
 * 工作空间管理：为每个用户创建独立的工作目录
 */
export class WorkspaceManager {
  /** 获取用户工作目录 */
  getUserWorkspace(userId: string): string {
    const dir = resolve(config.dataDir, "users", userId, "workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 获取用户会话数据目录 */
  getUserSessionsDir(userId: string): string {
    const dir = resolve(config.dataDir, "users", userId, "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
```

#### Step 2: 在会话创建时设置工作目录

在 WebSocket handler 中，创建会话时设置 `cwd` 为用户工作目录，并通过沙箱的 `fs-boundary` 限制文件访问范围。

数据目录结构：
```
data/
├── users.json
└── users/
    ├── <user-id-a>/
    │   ├── workspace/    # 用户 A 的工作目录
    │   └── sessions/     # 用户 A 的会话数据
    └── <user-id-b>/
        ├── workspace/    # 用户 B 的工作目录
        └── sessions/
```

### 验收标准

- [ ] 每个用户有独立的工作目录
- [ ] 文件操作被限制在用户目录内
- [ ] 用户 A 无法访问用户 B 的文件

---

## Task 5.9: React Web 前端

### 目标

实现浏览器端的聊天页面。

### 涉及文件

- `packages/server/web/` — React SPA 项目
- `packages/server/web/src/pages/LoginPage.tsx` — 新建
- `packages/server/web/src/pages/ChatPage.tsx` — 新建
- `packages/server/web/src/hooks/useWebSocket.ts` — 新建
- `packages/server/web/src/hooks/useAuth.ts` — 新建
- `packages/server/web/src/api/client.ts` — 新建

### 步骤

#### Step 1: 搭建 Vite + React 项目

在 `packages/server/web/` 下创建 Vite + React + TypeScript 项目。

```bash
cd packages/server/web
pnpm create vite . --template react-ts
```

#### Step 2: 创建 api/client.ts

```typescript
const API_BASE = "/api";

/** HTTP API 客户端 */
export const api = {
  async login(username: string, password: string) {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error("登录失败");
    return res.json();
  },

  async getModels(token: string) {
    const res = await fetch(`${API_BASE}/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.json();
  },

  async getSessions(token: string) {
    const res = await fetch(`${API_BASE}/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.json();
  },
};
```

#### Step 3: 创建 hooks/useAuth.ts

```typescript
import { useState, useCallback } from "react";
import { api } from "../api/client";

/**
 * 认证 Hook
 */
export function useAuth() {
  const [token, setToken] = useState<string | null>(
    localStorage.getItem("tx-cli-token")
  );
  const [user, setUser] = useState<any>(null);

  const login = useCallback(async (username: string, password: string) => {
    const result = await api.login(username, password);
    setToken(result.token);
    setUser(result.user);
    localStorage.setItem("tx-cli-token", result.token);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    localStorage.removeItem("tx-cli-token");
  }, []);

  return { token, user, login, logout, isAuthenticated: !!token };
}
```

#### Step 4: 创建 hooks/useWebSocket.ts

```typescript
import { useEffect, useRef, useCallback } from "react";

/**
 * WebSocket Hook
 * 管理 WebSocket 连接、消息收发
 */
export function useWebSocket(token: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Map<string, Set<(data: any) => void>>>(new Map());

  useEffect(() => {
    if (!token) return;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws?token=${token}`);

    ws.onopen = () => console.log("WebSocket 已连接");
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const listeners = listenersRef.current.get(data.type);
      listeners?.forEach((fn) => fn(data));
    };
    ws.onclose = () => console.log("WebSocket 已断开");

    wsRef.current = ws;
    return () => ws.close();
  }, [token]);

  const send = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const on = useCallback((type: string, callback: (data: any) => void) => {
    if (!listenersRef.current.has(type)) {
      listenersRef.current.set(type, new Set());
    }
    listenersRef.current.get(type)!.add(callback);
    return () => {
      listenersRef.current.get(type)?.delete(callback);
    };
  }, []);

  return { send, on };
}
```

#### Step 5: 创建 LoginPage.tsx

```tsx
import React, { useState } from "react";
import { useAuth } from "../hooks/useAuth";

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const { login } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(username, password);
    } catch (err) {
      setError("用户名或密码错误");
    }
  };

  return (
    <div style={{ maxWidth: 400, margin: "100px auto", padding: 20 }}>
      <h1>tx-cli Cloud</h1>
      <form onSubmit={handleSubmit}>
        <input
          placeholder="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          type="password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p style={{ color: "red" }}>{error}</p>}
        <button type="submit">登录</button>
      </form>
    </div>
  );
}
```

#### Step 6: 创建 ChatPage.tsx

```tsx
import React, { useState, useEffect } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import { useAuth } from "../hooks/useAuth";

export function ChatPage() {
  const { token } = useAuth();
  const { send, on } = useWebSocket(token);
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"agent" | "chat">("chat");

  useEffect(() => {
    const off1 = on("stream-token", (data) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          last.content += data.token;
          return [...prev];
        }
        return [...prev, { role: "assistant", content: data.token }];
      });
    });

    const off2 = on("tool-call", (data) => {
      setMessages((prev) => [...prev, { role: "tool", content: `调用工具: ${data.name}` }]);
    });

    return () => { off1(); off2(); };
  }, [on]);

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages((prev) => [...prev, { role: "user", content: input }]);
    send({ type: "chat", text: input, mode });
    setInput("");
  };

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: 20 }}>
      <div style={{ marginBottom: 10 }}>
        <button onClick={() => setMode("chat")} disabled={mode === "chat"}>Chat</button>
        <button onClick={() => setMode("agent")} disabled={mode === "agent"}>Agent</button>
      </div>
      <div style={{ height: 500, overflowY: "auto", border: "1px solid #ccc", padding: 10 }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <strong>{msg.role}:</strong> {msg.content}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", marginTop: 10 }}>
        <input
          style={{ flex: 1 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="输入消息..."
        />
        <button onClick={handleSend}>发送</button>
      </div>
    </div>
  );
}
```

### 验收标准

- [ ] 登录页面能正常登录
- [ ] 聊天页面能正常发送和接收消息
- [ ] WebSocket 连接稳定
- [ ] Agent/Chat 模式切换正常

---

## Task 5.10: 部署与测试

### 目标

配置 Docker 部署和集成测试。

### 涉及文件

- `packages/server/Dockerfile` — 新建
- `packages/server/.env.example` — 新建

### 步骤

#### Step 1: 创建 Dockerfile

```dockerfile
FROM node:22-slim

WORKDIR /app

# 安装 pnpm
RUN npm install -g pnpm@10.5.2

# 复制 workspace 配置
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/

# 安装依赖
RUN pnpm install --frozen-lockfile

# 复制源码
COPY packages/shared/ packages/shared/
COPY packages/core/ packages/core/
COPY packages/server/ packages/server/

# 构建
RUN pnpm --filter @tx-cli/server build

# 构建前端
RUN cd packages/server/web && pnpm install && pnpm build

# 数据目录
VOLUME /app/data

EXPOSE 3000

CMD ["node", "packages/server/dist/index.js"]
```

#### Step 2: 创建 .env.example

```bash
# 服务端口
TX_CLI_PORT=3000

# 数据目录
TX_CLI_DATA_DIR=./data

# JWT 密钥（生产环境必须修改）
TX_CLI_JWT_SECRET=change-me-in-production
```

#### Step 3: 创建服务入口 index.ts

```typescript
import { createApp } from "./app";
import { config } from "./config";

const { server } = createApp();

server.listen(config.port, () => {
  console.log(`tx-cli Cloud Server 已启动`);
  console.log(`访问地址: http://localhost:${config.port}`);
  console.log(`WebSocket: ws://localhost:${config.port}/ws`);
});
```

#### Step 4: 测试部署

```bash
# 本地测试
pnpm --filter @tx-cli/server dev

# Docker 构建
docker build -t tx-cli-server -f packages/server/Dockerfile .

# Docker 运行
docker run -p 3000:3000 -v ./data:/app/data tx-cli-server
```

### 验收标准

- [ ] `pnpm --filter @tx-cli/server dev` 能启动服务
- [ ] Docker 镜像能正常构建
- [ ] 容器内服务正常运行
- [ ] 浏览器能正常访问
