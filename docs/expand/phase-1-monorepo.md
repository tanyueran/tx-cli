# Phase 1: pnpm + monorepo 拆分

> 前置依赖：无
> 预计产出：pnpm workspace + 4 个独立包（shared/core/scaffold/cli），功能不变，所有测试通过

## 概述

将当前单体项目拆分为 pnpm monorepo，按职责分为 4 个包。本阶段只做结构迁移，不做任何功能变更。

**核心原则：纯结构迁移，零功能变更，所有测试必须通过。**

---

## Task 1.1: 初始化 pnpm workspace

### 目标

创建 pnpm workspace 基础设施。

### 涉及文件

- `pnpm-workspace.yaml` — 新建
- `package.json`（根）— 重写
- `tsconfig.base.json` — 新建

### 步骤

#### Step 1: 创建 pnpm-workspace.yaml

```yaml
packages:
  - "packages/*"
```

#### Step 2: 重写根 package.json

将现有 `package.json` 的 `dependencies` 和 `devDependencies` 保留在根目录作为共享依赖，添加 workspace 管理脚本：

```json
{
  "name": "tx-cli-monorepo",
  "private": true,
  "version": "0.11.0",
  "packageManager": "pnpm@10.5.2",
  "engines": {
    "node": ">=20.11.0"
  },
  "scripts": {
    "dev": "pnpm --filter @tx-cli/cli dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "test:watch": "pnpm -r test:watch",
    "type-check": "pnpm -r type-check",
    "lint": "pnpm -r lint",
    "lint:fix": "pnpm -r lint:fix",
    "clean": "pnpm -r clean"
  }
}
```

#### Step 3: 创建 tsconfig.base.json

从现有 `tsconfig.json` 提取共享配置：

```json
{
  "compilerOptions": {
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "module": "esnext",
    "target": "esnext",
    "moduleResolution": "bundler",
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

### 验收标准

- [ ] `pnpm-workspace.yaml` 存在且配置正确
- [ ] 根 `package.json` 包含 workspace 管理脚本
- [ ] `tsconfig.base.json` 包含共享编译选项

---

## Task 1.2: 迁移 shared 包

### 目标

将 `src/shared/` 迁移为独立的 `@tx-cli/shared` 包。

### 涉及文件

- `packages/shared/package.json` — 新建
- `packages/shared/tsconfig.json` — 新建
- `packages/shared/src/` — 从 `src/shared/` 迁移
- `packages/shared/src/index.ts` — 新建（统一导出）

### 步骤

#### Step 1: 创建 packages/shared/package.json

```json
{
  "name": "@tx-cli/shared",
  "version": "0.11.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "type-check": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "fs-extra": "11.1.1"
  },
  "devDependencies": {
    "@types/fs-extra": "11.0.4",
    "@types/node": "^26.4.1",
    "typescript": "5.9.2"
  }
}
```

#### Step 2: 创建 packages/shared/tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"]
  },
  "include": ["./src/**/*"]
}
```

#### Step 3: 迁移源文件

将 `src/shared/` 下所有文件复制到 `packages/shared/src/`：

```
src/shared/fs.ts           → packages/shared/src/fs.ts
src/shared/string.ts       → packages/shared/src/string.ts
src/shared/paths.ts        → packages/shared/src/paths.ts
src/shared/errors.ts       → packages/shared/src/errors.ts
src/shared/text.ts         → packages/shared/src/text.ts
src/shared/timeout.ts      → packages/shared/src/timeout.ts
src/shared/warnings.ts     → packages/shared/src/warnings.ts
src/shared/serial-queue.ts → packages/shared/src/serial-queue.ts
src/shared/turn-cancel.ts  → packages/shared/src/turn-cancel.ts
src/shared/config-merge.ts → packages/shared/src/config-merge.ts
src/shared/user-config.ts  → packages/shared/src/user-config.ts
src/shared/interactive-prompt.ts → packages/shared/src/interactive-prompt.ts
```

#### Step 4: 创建 packages/shared/src/index.ts

统一导出所有共享模块：

```typescript
export * from "./fs";
export * from "./string";
export * from "./paths";
export * from "./errors";
export * from "./text";
export * from "./timeout";
export * from "./warnings";
export * from "./serial-queue";
export * from "./turn-cancel";
export * from "./config-merge";
export * from "./user-config";
export * from "./interactive-prompt";
```

#### Step 5: 更新 shared 内部的 import 路径

将 `src/shared/` 内部文件之间的相对引用（如 `./errors`）保持不变，因为它们在同一个包内。

### 验收标准

- [ ] `packages/shared/` 目录结构完整
- [ ] `packages/shared/src/index.ts` 导出所有模块
- [ ] `pnpm --filter @tx-cli/shared type-check` 通过

---

## Task 1.3: 迁移 core 包

### 目标

将 `src/core/` 迁移为独立的 `@tx-cli/core` 包。

### 涉及文件

- `packages/core/package.json` — 新建
- `packages/core/tsconfig.json` — 新建
- `packages/core/src/` — 从 `src/core/` 迁移
- `packages/core/src/index.ts` — 新建（统一导出）

### 步骤

#### Step 1: 创建 packages/core/package.json

```json
{
  "name": "@tx-cli/core",
  "version": "0.11.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./conversation/*": "./src/conversation/*",
    "./llm/*": "./src/llm/*",
    "./tools/*": "./src/tools/*",
    "./mcp/*": "./src/mcp/*",
    "./sandbox/*": "./src/sandbox/*",
    "./skills/*": "./src/skills/*"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "type-check": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@tx-cli/shared": "workspace:*",
    "@anthropic-ai/sandbox-runtime": "^0.0.80",
    "@modelcontextprotocol/sdk": "^1.32.1",
    "openai": "7.32.0",
    "picocolors": "1.1.1",
    "prompts": "2.4.2",
    "connect": "^3.7.0",
    "serve-static": "^2.2.0"
  },
  "devDependencies": {
    "@types/connect": "^3.4.38",
    "@types/prompts": "2.4.2",
    "@types/serve-static": "^1.15.8",
    "@types/node": "^26.4.1",
    "typescript": "5.9.2"
  }
}
```

#### Step 2: 创建 packages/core/tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"],
    "paths": {
      "@tx-cli/shared": ["../shared/src/index.ts"]
    }
  },
  "include": ["./src/**/*"]
}
```

#### Step 3: 迁移源文件

将 `src/core/` 下所有内容复制到 `packages/core/src/`，保持目录结构不变：

```
src/core/conversation/  → packages/core/src/conversation/
src/core/llm/           → packages/core/src/llm/
src/core/tools/         → packages/core/src/tools/
src/core/mcp/           → packages/core/src/mcp/
src/core/sandbox/       → packages/core/src/sandbox/
src/core/skills/        → packages/core/src/skills/
src/core/scaffold/      → packages/core/src/scaffold/  (暂时保留，Task 1.4 迁移)
src/core/copy/          → packages/core/src/copy/      (暂时保留，Task 1.4 迁移)
src/core/server/        → packages/core/src/server/    (暂时保留，Task 1.4 迁移)
src/core/commit-fix/    → packages/core/src/commit-fix/ (暂时保留，Task 1.4 迁移)
```

#### Step 4: 更新 core 内部对 shared 的 import

将所有 `from "../../shared/xxx"` 或 `from "../shared/xxx"` 替换为 `from "@tx-cli/shared"`。

具体替换规则：
- `from "../../shared/fs"` → `from "@tx-cli/shared"`
- `from "../shared/errors"` → `from "@tx-cli/shared"`
- `from "../../shared/user-config"` → `from "@tx-cli/shared"`
- 以此类推

#### Step 5: 创建 packages/core/src/index.ts

```typescript
// 会话
export * from "./conversation";
export * from "./conversation/agent";
export * from "./conversation/chat";

// LLM
export * from "./llm";

// 工具
export * from "./tools";

// MCP
export * from "./mcp";

// 沙箱
export * from "./sandbox";

// 技能
export * from "./skills";
```

### 验收标准

- [ ] `packages/core/` 目录结构完整
- [ ] 所有对 shared 的引用已改为 `@tx-cli/shared`
- [ ] `pnpm --filter @tx-cli/core type-check` 通过

---

## Task 1.4: 迁移 scaffold 包

### 目标

将脚手架相关功能（scaffold、copy、commit-fix、server）迁移为独立的 `@tx-cli/scaffold` 包。

### 涉及文件

- `packages/scaffold/package.json` — 新建
- `packages/scaffold/tsconfig.json` — 新建
- `packages/scaffold/src/` — 从 core 中迁移
- `template/` → `packages/scaffold/template/` — 迁移

### 步骤

#### Step 1: 创建 packages/scaffold/package.json

```json
{
  "name": "@tx-cli/scaffold",
  "version": "0.11.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "type-check": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@tx-cli/shared": "workspace:*",
    "handlebars": "4.7.7",
    "fs-extra": "11.1.1",
    "simple-git": "3.28.0",
    "connect": "^3.7.0",
    "serve-static": "^2.2.0",
    "open": "^10.2.0"
  },
  "devDependencies": {
    "@types/connect": "^3.4.38",
    "@types/serve-static": "^1.15.8",
    "@types/fs-extra": "11.0.4",
    "@types/node": "^26.4.1",
    "typescript": "5.9.2"
  }
}
```

#### Step 2: 创建 packages/scaffold/tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"],
    "paths": {
      "@tx-cli/shared": ["../shared/src/index.ts"]
    }
  },
  "include": ["./src/**/*"]
}
```

#### Step 3: 迁移源文件

```
packages/core/src/scaffold/   → packages/scaffold/src/scaffold/
packages/core/src/copy/       → packages/scaffold/src/copy/
packages/core/src/server/     → packages/scaffold/src/server/
packages/core/src/commit-fix/ → packages/scaffold/src/commit-fix/
template/                     → packages/scaffold/template/
```

#### Step 4: 更新 import 路径

将这些模块中对 shared 的引用改为 `@tx-cli/shared`。

#### Step 5: 创建 packages/scaffold/src/index.ts

```typescript
export * from "./scaffold";
export * from "./copy";
export * from "./server";
export * from "./commit-fix";
```

#### Step 6: 从 core 包中删除已迁移的模块

删除 `packages/core/src/` 下的 `scaffold/`、`copy/`、`server/`、`commit-fix/` 目录。

#### Step 7: 更新 core 包的 index.ts

移除对已迁移模块的导出。

### 验收标准

- [ ] `packages/scaffold/` 目录结构完整
- [ ] `template/` 目录迁移到 `packages/scaffold/template/`
- [ ] core 包中不再包含 scaffold/copy/server/commit-fix
- [ ] `pnpm --filter @tx-cli/scaffold type-check` 通过

---

## Task 1.5: 迁移 cli 包

### 目标

将 CLI 入口迁移为独立的 `@tx-cli/cli` 包。

### 涉及文件

- `packages/cli/package.json` — 新建
- `packages/cli/tsconfig.json` — 新建
- `packages/cli/src/` — 从 `src/` 迁移
- `packages/cli/bin/` — 从 `bin/` 迁移

### 步骤

#### Step 1: 创建 packages/cli/package.json

```json
{
  "name": "@tx-cli/cli",
  "version": "0.11.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "bin": {
    "tx-cli": "./bin/tx-cli"
  },
  "files": ["bin", "dist"],
  "scripts": {
    "dev": "tsx ./src/cli.ts",
    "build": "rollup --config rollup.config.mjs",
    "type-check": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@tx-cli/core": "workspace:*",
    "@tx-cli/scaffold": "workspace:*",
    "@tx-cli/shared": "workspace:*",
    "commander": "12.1.0",
    "picocolors": "1.1.1",
    "open": "^10.2.0",
    "prompts": "2.4.2"
  },
  "devDependencies": {
    "@types/node": "^26.4.1",
    "@types/prompts": "2.4.2",
    "typescript": "5.9.2",
    "tsx": "^4.23.13"
  }
}
```

#### Step 2: 创建 packages/cli/tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"],
    "paths": {
      "@tx-cli/core": ["../core/src/index.ts"],
      "@tx-cli/shared": ["../shared/src/index.ts"],
      "@tx-cli/scaffold": ["../scaffold/src/index.ts"]
    }
  },
  "include": ["./src/**/*"]
}
```

#### Step 3: 迁移源文件

```
src/cli.ts          → packages/cli/src/cli.ts
src/index.ts        → packages/cli/src/index.ts
src/program/        → packages/cli/src/program/
bin/                → packages/cli/bin/
```

#### Step 4: 更新 import 路径

将 CLI 层中对 core、shared、scaffold 的引用改为包名：

- `from "../core/conversation/agent"` → `from "@tx-cli/core"`
- `from "../core/conversation/chat"` → `from "@tx-cli/core"`
- `from "../core/llm"` → `from "@tx-cli/core"`
- `from "../core/sandbox"` → `from "@tx-cli/core"`
- `from "../shared/errors"` → `from "@tx-cli/shared"`
- `from "../core/server"` → `from "@tx-cli/scaffold"`
- `from "../core/scaffold"` → `from "@tx-cli/scaffold"`
- `from "../core/copy"` → `from "@tx-cli/scaffold"`
- `from "../core/commit-fix"` → `from "@tx-cli/scaffold"`
- 以此类推

注意：如果 `@tx-cli/core` 的 index.ts 没有导出所有需要的模块，需要补充导出或调整 import 路径。

#### Step 5: 迁移 rollup 配置

将 `rollup.config.mjs` 复制到 `packages/cli/rollup.config.mjs`，调整输入输出路径。

#### Step 6: 迁移其他配置文件

- `.npmrc`（如果有）— 保留在根目录
- `changelog.config.mjs` — 保留在根目录
- `script/publish.cjs` — 保留在根目录，调整路径

### 验收标准

- [ ] `packages/cli/` 目录结构完整
- [ ] `bin/tx-cli` 可执行文件存在
- [ ] `pnpm --filter @tx-cli/cli type-check` 通过
- [ ] `pnpm dev` 能正常启动 CLI

---

## Task 1.6: 构建与测试验证

### 目标

配置构建和测试，确保所有功能正常。

### 涉及文件

- `vitest.config.ts`（根）— 新建或修改
- `vitest.workspace.ts`（根）— 新建
- `test/` — 更新 import 路径
- `rollup.config.mjs`（根）— 删除或保留为聚合构建

### 步骤

#### Step 1: 创建 vitest.workspace.ts

```typescript
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*/vitest.config.ts",
  {
    test: {
      name: "integration",
      include: ["test/**/*.test.ts"],
    },
  },
]);
```

#### Step 2: 更新测试文件的 import 路径

将 `test/` 中所有对 `../src/` 的引用改为包名引用：

- `from "../src/core/..."` → `from "@tx-cli/core"`
- `from "../src/shared/..."` → `from "@tx-cli/shared"`
- `from "../src/program/..."` → `from "@tx-cli/cli"`

#### Step 3: 创建根 vitest.config.ts

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@tx-cli/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@tx-cli/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
      "@tx-cli/scaffold": new URL("./packages/scaffold/src/index.ts", import.meta.url).pathname,
      "@tx-cli/cli": new URL("./packages/cli/src/index.ts", import.meta.url).pathname,
    },
  },
});
```

#### Step 4: 运行全部测试

```bash
pnpm test
```

#### Step 5: 运行类型检查

```bash
pnpm type-check
```

#### Step 6: 验证 CLI 功能

```bash
pnpm dev -- --help
pnpm dev -- chat "你好"
pnpm dev -- agent "列出当前目录文件"
```

#### Step 7: 清理旧文件

确认新结构工作正常后，删除旧的 `src/` 目录。

### 验收标准

- [ ] `pnpm test` 全部测试通过
- [ ] `pnpm type-check` 无错误
- [ ] `pnpm dev -- --help` 正常输出
- [ ] `pnpm dev -- chat "你好"` 正常对话
- [ ] `pnpm dev -- agent "列出当前目录文件"` 正常执行
- [ ] 旧的 `src/` 目录已删除
