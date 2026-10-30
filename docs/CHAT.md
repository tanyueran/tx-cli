# chat 命令详解

与大模型轻量只读问答，支持任何 OpenAI 兼容接口（DeepSeek、Kimi、GLM、OpenAI 等）。

## 基本用法

- 传入问题：单次问答，流式输出回答后退出
- 不传参数（或纯空白，如 `tx chat ""`）：进入多轮对话模式，持续输入问题对话，输入 `exit`/`quit` 或按 `Ctrl+C` 退出
- 工具调用默认开启、不可关闭：仅支持随版本内置发布的固定工具集，不支持运行时动态注册——`read_file`、`list_dir`、`glob`、`grep` 用于读取与检索本地文件（读侧仍受沙箱禁读边界管控），`web_search` 用于联网搜索实时信息；只读语义由代码强制：固定不装配 bash、MCP 与写侧工具（`write_file` / `edit_file`），创建或修改文件请用 `agent` 命令；每次调用会打印 `→ 调用 ...` 提示
- 支持技能（skills）：扫描 `~/.tx-cli/skills`（用户级）与 `./.tx-cli/skills`（项目级，同名时项目级优先）中的 `SKILL.md` 技能手册，发现技能时自动装配 `load_skill` 工具，模型按需加载手册后按其指引执行；多轮对话中可用 `/skills` 查看技能清单
- 不支持 MCP：为保持轻量，`chat` 不装配 MCP 服务器，需要接入外部工具请用 `agent` 命令（详见 [agent 命令详解](./AGENT.md)）
- 单次问答与多轮对话均走 Responses API 无状态模式（要求所配置的服务支持该接口）：服务端不留存会话，多轮历史由本地维护并每轮全量发送
- 单次问答的工具调用轮数上限为 8 轮，达到上限后模型将基于已有信息直接作答（黄字提示）

```bash
# 单次问答（工具调用默认开启，可直接让模型读取本地文件）
tx-cli chat 当前目录 package.json 的 name 是什么

# 普通问答
tx-cli chat 怎么用 fs.rm 递归删除目录

# 指定思考档位（优先级：--think > 配置文件 llm.thinkingLevel > low）
tx-cli chat --think high "证明这道题"

# 进入多轮对话（深度思考兜底 low，会话内 /think 随时切换）
tx-cli chat
tx-cli chat --think low
```

## 选项

| 选项 | 说明 |
|---|---|
| `--think <level>` | 思考档位：`off` \| `low` \| `medium` \| `high`，优先级：命令行 > 项目配置 > 全局配置（chat 最终默认 `low`，仅对本次对话生效） |

## 深度思考档位

统一档位 `off / low / medium / high`，按服务的协议风格自动翻译为对应请求字段。`chat` 与 `agent` 命令的档位优先级均为：`--think` > 配置文件 `llm.thinkingLevel`（项目配置优先于全局配置）> 内置默认（`chat` 为 `low`，`agent` 为 `medium`）。

| 协议风格 | 适配服务 | 档位翻译方式 |
|---|---|---|
| `reasoning_effort` | OpenAI 官方（o 系列/gpt-5）、OpenRouter、vLLM 等 | `reasoning_effort: <档位>`，档位即强度 |
| `thinking` | 火山方舟（豆包）、智谱 GLM | `thinking: { type }`，仅开/关，low/medium/high 均按 enabled 折算 |
| `enable_thinking` | 阿里 Qwen DashScope 兼容模式 | `enable_thinking: true/false`，仅开/关 |
| `none` | DeepSeek 等 | 不下发思考字段（靠换 reasoner 类模型切换） |

风格按 `baseUrl` 自动推断（`volces.com`/`doubao`/`bigmodel.cn` → `thinking`，`dashscope.aliyuncs.com` → `enable_thinking`，其余 → `reasoning_effort`），推断不准时可用配置覆盖。`off` 最为保守：`reasoning_effort`/`none` 风格下不下发任何思考字段，最大化兼容不支持思考扩展的服务。

模型返回深度思考内容时以暗色流式输出（以 `……` 标记开始），未返回思考内容则不产生任何额外输出。

多轮对话模式支持内联命令 `/think`：无参查看当前档位，带参切换（如 `/think high`，下一轮生效），非法档位提示后保留原档位。

## 配置

首次使用需配置接入信息，任选一种方式：

1. 首次运行时的交互式引导，配置会保存到 `~/.tx-cli/config.json`（文件权限仅限当前用户读写）
2. 直接写入配置文件的 `llm` 段：全局 `~/.tx-cli/config.json` 或项目 `<cwd>/.tx-cli/config.json`（同名字段项目配置优先）

**配置分层合并规则**（适用于 `llm`、`mcp`、`mcpServers` 各段）：优先级为命令行选项 > 项目配置（`<cwd>/.tx-cli/config.json`）> 全局配置（`~/.tx-cli/config.json`）；标量字段高层覆盖低层，数组字段（如 `mcp.rules.allow`）两层合并去重（全局在前、项目在后），`mcpServers` 按服务器名合并（同名以项目为准，启动时告警提示）。`sandbox` 段不适用此规则：采用能力感知合并，项目配置仅可收紧沙箱能力，放宽类字段（如 `network.allowedDomains`、`trustDirectories`）来自项目配置时被忽略并告警，详见 [agent 命令详解](./AGENT.md) 的「项目沙箱配置（能力感知合并）」。

**`llm` 段字段：**

| 字段 | 必填 | 说明 |
|---|---|---|
| `apiKey` | 是 | 服务 API Key，缺失时首次运行进入交互式引导 |
| `baseUrl` | 是 | OpenAI 兼容接口地址（Responses API 无状态模式） |
| `model` | 是 | 模型名 |
| `thinkingLevel` | 否 | 全局默认思考档位：`off` \| `low` \| `medium` \| `high`；未配置时随命令兜底（`chat` 为 `low`，`agent` 为 `medium`） |
| `thinkingStyle` | 否 | 思考协议风格：`reasoning_effort` \| `thinking` \| `enable_thinking` \| `none`，缺省按 `baseUrl` 推断（见上方协议风格表） |
| `thinkingEffortMap` | 否 | 档位 → 服务端实际值映射（适配仅支持部分档位的服务） |

`llm` 段示例（写入 `~/.tx-cli/config.json`，项目配置可覆盖/合并同名字段）：

```jsonc
{
  "llm": {
    "apiKey": "sk-xxx",
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    // 全局默认思考档位，未配置时 chat 兜底 low、agent 兜底 medium
    "thinkingLevel": "medium",
    // 思考协议风格，缺省按 baseUrl 推断
    "thinkingStyle": "reasoning_effort",
    // 可选：档位 → 服务端实际值的高级映射（适配仅支持部分档位的服务）
    "thinkingEffortMap": { "low": "high", "medium": "high", "high": "high" }
  }
}
```
