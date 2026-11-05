# Phase 3: 多模型/多 Provider 配置扩展

> 前置依赖：Phase 2 完成
> 预计产出：支持配置多个 LLM Provider 和模型，可在会话中切换

## 概述

当前 `user-config.ts` 只支持单 provider 配置。本阶段扩展为多 provider/model 配置，支持在 CLI、桌面端、云端中切换不同的模型。

**核心原则：向后兼容，旧配置自动迁移。**

---

## Task 3.1: 扩展配置 Schema

### 目标

新增 `providers` 配置段，支持多 provider、多 model。

### 涉及文件

- `packages/core/src/llm/types.ts` — 修改
- `packages/shared/src/user-config.ts` — 修改

### 步骤

#### Step 1: 扩展 LlmConfig 类型

在 `packages/core/src/llm/types.ts` 中新增：

```typescript
/** 单个 Provider 配置 */
export interface ProviderConfig {
  /** API 基础地址 */
  baseUrl: string;
  /** API 密钥 */
  apiKey: string;
  /** 该 provider 下可用的模型列表 */
  models: string[];
  /** 思考风格（可选，覆盖自动推断） */
  thinkingStyle?: ThinkingStyle;
  /** 思考档位映射（可选） */
  thinkingEffortMap?: Partial<Record<ThinkingLevel, string>>;
  /** 计费配置（可选） */
  pricing?: {
    inputPerMillion: number;
    outputPerMillion: number;
    currency?: string;
  };
}

/** 多 Provider 配置 */
export interface MultiProviderConfig {
  /** 各 provider 配置，key 为 provider 名称 */
  providers: Record<string, ProviderConfig>;
  /** 默认 provider 名称 */
  defaultProvider: string;
  /** 默认模型 */
  defaultModel: string;
}
```

#### Step 2: 扩展用户配置文件结构

在 `~/.tx-cli/config.json` 中新增 `llm.providers` 段：

```jsonc
{
  "llm": {
    // 新格式：多 provider
    "providers": {
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "sk-xxx",
        "models": ["gpt-4o", "gpt-4o-mini", "o1", "o1-mini"]
      },
      "anthropic": {
        "baseUrl": "https://api.anthropic.com/v1",
        "apiKey": "sk-ant-xxx",
        "models": ["claude-sonnet-4-5-20250929", "claude-opus-4-6"]
      },
      "deepseek": {
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": "sk-xxx",
        "models": ["deepseek-chat", "deepseek-reasoner"]
      }
    },
    "defaultProvider": "openai",
    "defaultModel": "gpt-4o",

    // 旧格式：单 provider（向后兼容，自动迁移）
    "baseUrl": "...",
    "apiKey": "...",
    "model": "..."
  }
}
```

#### Step 3: 实现配置迁移逻辑

在 `user-config.ts` 中，加载配置时检测旧格式并自动迁移：

```typescript
/**
 * 检测并迁移旧格式配置为多 provider 格式
 * 如果 llm 段包含 baseUrl/apiKey 但不包含 providers，则自动迁移
 */
function migrateLlmConfig(llmConfig: any): MultiProviderConfig | undefined {
  if (llmConfig.providers) {
    // 已经是新格式
    return llmConfig as MultiProviderConfig;
  }
  if (llmConfig.baseUrl && llmConfig.apiKey) {
    // 旧格式，自动迁移
    const providerName = inferProviderName(llmConfig.baseUrl);
    return {
      providers: {
        [providerName]: {
          baseUrl: llmConfig.baseUrl,
          apiKey: llmConfig.apiKey,
          models: llmConfig.model ? [llmConfig.model] : [],
        },
      },
      defaultProvider: providerName,
      defaultModel: llmConfig.model || "",
    };
  }
  return undefined;
}

/** 根据 baseUrl 推断 provider 名称 */
function inferProviderName(baseUrl: string): string {
  if (baseUrl.includes("openai.com")) return "openai";
  if (baseUrl.includes("anthropic.com")) return "anthropic";
  if (baseUrl.includes("deepseek.com")) return "deepseek";
  if (baseUrl.includes("volces.com") || baseUrl.includes("doubao")) return "doubao";
  if (baseUrl.includes("bigmodel.cn")) return "zhipu";
  if (baseUrl.includes("dashscope.aliyuncs.com")) return "qwen";
  return "custom";
}
```

### 验收标准

- [ ] 新类型定义完整
- [ ] 旧格式配置能自动迁移
- [ ] 新格式配置能正常加载

---

## Task 3.2: 实现 Provider 注册表

### 目标

创建一个 Provider 注册表，管理多 provider 配置。

### 涉及文件

- `packages/core/src/llm/provider-registry.ts` — 新建

### 步骤

#### Step 1: 创建 ProviderRegistry

```typescript
import type { MultiProviderConfig, ProviderConfig } from "./types";

/**
 * Provider 注册表：管理多 provider 配置
 * 提供查询、切换、列出可用模型的能力
 */
export class ProviderRegistry {
  private config: MultiProviderConfig;

  constructor(config: MultiProviderConfig) {
    this.config = config;
  }

  /** 获取所有 provider 名称 */
  getProviderNames(): string[] {
    return Object.keys(this.config.providers);
  }

  /** 获取指定 provider 的配置 */
  getProvider(name: string): ProviderConfig | undefined {
    return this.config.providers[name];
  }

  /** 获取指定 provider 的模型列表 */
  getModels(providerName: string): string[] {
    return this.config.providers[providerName]?.models ?? [];
  }

  /** 获取默认 provider 名称 */
  getDefaultProvider(): string {
    return this.config.defaultProvider;
  }

  /** 获取默认模型 */
  getDefaultModel(): string {
    return this.config.defaultModel;
  }

  /** 获取当前生效的 provider 配置 */
  getCurrentProvider(): { name: string; config: ProviderConfig } {
    const name = this.config.defaultProvider;
    const config = this.config.providers[name];
    if (!config) {
      throw new Error(`Provider "${name}" 未配置`);
    }
    return { name, config };
  }

  /** 切换到指定 provider 和模型 */
  switchTo(providerName: string, model: string): void {
    if (!this.config.providers[providerName]) {
      throw new Error(`Provider "${providerName}" 不存在`);
    }
    this.config.defaultProvider = providerName;
    this.config.defaultModel = model;
  }

  /** 列出所有可用的 provider + model 组合 */
  listAll(): Array<{ provider: string; model: string }> {
    const result: Array<{ provider: string; model: string }> = [];
    for (const [provider, config] of Object.entries(this.config.providers)) {
      for (const model of config.models) {
        result.push({ provider, model });
      }
    }
    return result;
  }
}
```

### 验收标准

- [ ] ProviderRegistry 类实现完整
- [ ] 能正确管理多 provider 配置

---

## Task 3.3: 改造 LLM Client 工厂

### 目标

支持按 provider + model 创建 LLM 客户端。

### 涉及文件

- `packages/core/src/llm/client.ts` — 修改
- `packages/core/src/llm/config.ts` — 修改
- `packages/core/src/llm/index.ts` — 修改

### 步骤

#### Step 1: 修改 client.ts

让 `streamResponse` 支持从 ProviderRegistry 获取配置：

```typescript
// 新增：从 ProviderRegistry 创建请求参数
export function createRequestFromRegistry(
  registry: ProviderRegistry,
  providerName?: string,
  model?: string,
): { baseUrl: string; apiKey: string; model: string } {
  const provider = providerName
    ? { name: providerName, config: registry.getProvider(providerName)! }
    : registry.getCurrentProvider();

  return {
    baseUrl: provider.config.baseUrl,
    apiKey: provider.config.apiKey,
    model: model || registry.getDefaultModel(),
  };
}
```

#### Step 2: 修改 config.ts

更新 `loadLlmConfig` 函数，支持加载多 provider 配置：

```typescript
export async function loadLlmConfig(): Promise<LlmConfig & { registry?: ProviderRegistry }> {
  // ... 现有逻辑 ...

  // 尝试加载多 provider 配置
  const multiConfig = migrateLlmConfig(rawConfig.llm);
  if (multiConfig) {
    const registry = new ProviderRegistry(multiConfig);
    return {
      ...singleConfig,
      registry,
    };
  }

  return singleConfig;
}
```

#### Step 3: 更新导出

在 `packages/core/src/llm/index.ts` 中导出 ProviderRegistry。

### 验收标准

- [ ] 能按 provider + model 创建请求
- [ ] 向后兼容单 provider 配置
- [ ] `pnpm --filter @tx-cli/core type-check` 通过

---

## Task 3.4: 配置向导升级

### 目标

升级交互式配置向导，支持添加/编辑多个 provider。

### 涉及文件

- `packages/core/src/llm/config-wizard.ts` — 修改

### 步骤

#### Step 1: 添加 provider 管理命令

在配置向导中新增选项：

```
? 选择操作：
  ❯ 添加 Provider
    编辑 Provider
    删除 Provider
    设置默认 Provider/Model
    查看当前配置
    完成
```

#### Step 2: 实现添加 Provider 流程

```
? Provider 名称：openai
? API Base URL：https://api.openai.com/v1
? API Key：sk-xxx
? 模型列表（逗号分隔）：gpt-4o, gpt-4o-mini
```

#### Step 3: 实现模型选择流程

在对话开始前或会话中，支持选择模型：

```
? 选择 Provider：
  ❯ openai
    anthropic
    deepseek

? 选择模型：
  ❯ gpt-4o
    gpt-4o-mini
    o1
```

### 验收标准

- [ ] 配置向导支持添加/编辑/删除 provider
- [ ] 支持设置默认 provider 和模型
- [ ] 配置能正确保存到 `~/.tx-cli/config.json`

---

## Task 3.5: 测试验证

### 目标

确保多 provider 配置正常工作。

### 步骤

#### Step 1: 编写单元测试

测试 ProviderRegistry 的各种操作。

#### Step 2: 测试配置迁移

测试旧格式配置自动迁移到新格式。

#### Step 3: 运行全部测试

```bash
pnpm test
```

#### Step 4: 功能验证

```bash
pnpm dev -- chat "你好"  # 使用默认 provider
```

### 验收标准

- [ ] 全部测试通过
- [ ] 旧配置自动迁移正常
- [ ] 多 provider 配置正常工作
