# @tanyueran/cli

| 一个命令行工具，可以创建项目，添加模块，与大模型对话，以及支持一些简单的工具操作命令

## 安装

| npm install -g @tanyueran/cli

## 用法

```text

tx-cli [command] [options]

Options:
  -V, --version                               output the version number
  -h, --help                                  display help for command

Commands:
  add [module-name]                           添加模块
  create [project-name]                       创建项目
  copy [options] <src> <dest>                 复制文件或目录，支持过滤某些文件
  server [options]                            启动一个本地HTTP服务器
  git-rename <old-model-url> <new-model-url>  git重命名模块
  commit-fix <message...>                     根据ones信息改为 fix(#id): title 格式提交git commit
  chat [options] [question...]                与大模型对话：传入问题为单次问答，不带参数进入多轮对话
  agent [options] [task...]                   让 AI Agent 执行任务：传入任务为单次执行，不带参数进入多轮任务模式
  help [command]                              display help for command
```

### 各命令说明

#### `add [module-name]`

添加模块。不传模块名称时，会以交互式提示输入。

```bash
tx-cli add user-profile
```

#### `create [project-name]`

创建项目。不传项目名称时，会以交互式提示输入。

```bash
tx-cli create my-app
```

#### `copy <src> <dest>`

复制文件或目录，支持按规则排除部分文件。复制走字节流，二进制文件与权限位按原样保留。

目标路径语义与 `cp` 一致：

| 源类型 | 目标状态 | 结果 |
|---|---|---|
| 文件 | 不存在 | 作为目标文件路径写入 |
| 文件 | 已存在目录 | 复制进该目录（`dest/<源文件名>`） |
| 目录 | 不存在 | 创建后复制内容 |
| 目录 | 已存在目录 | 复制为 `dest/<源目录名>` |
| 目录 | 已存在文件 | 报错 |

**选项：**

| 选项 | 说明 |
|---|---|
| `-f, --filter <pattern>` | 排除匹配的文件/目录，可多次传入。glob 语法，基于源目录的相对路径匹配 |
| `-F, --force` | 目标已存在时直接覆盖，跳过交互确认 |

> 说明：`--filter` 为**排除**语义，命中即跳过。`--filter "node_modules/**"` 会跳过整个 `node_modules` 目录（含空目录本身）；`--filter "**/*.log"` 会跳过所有 `.log` 文件。

```bash
# 复制单文件
tx-cli copy src/index.ts dist/index.ts

# 递归复制目录，排除日志与依赖
tx-cli copy ./src ./backup --filter "**/*.log" --filter "node_modules/**"

# 目标已存在时直接覆盖，不再交互确认
tx-cli copy ./src ./backup --force
```

#### `server [options]`

启动一个本地 HTTP 静态文件服务器。

| 选项 | 说明 | 默认值 |
|---|---|---|
| `-p, --port <number>` | 端口号 | `8080` |
| `-H, --host <host>` | 主机地址 | `localhost` |
| `-d, --directory <path>` | 服务的目录 | `.` |
| `-o, --open` | 启动后自动打开浏览器 | - |
| `-s, --silent` | 静默模式，不输出信息 | - |
| `--header <json>` | 自定义 HTTP 响应头 | `{}` |

```bash
tx-cli server -p 3000 -o
tx-cli server -d ./dist --header '{"Cache-Control":"no-cache"}'
```

#### `git-rename <old-model-url> <new-model-url>`

git 重命名模块名称，主要用于 git 跟踪的文件的名称大小写转换。通过两次 mv（先改中间名再改目标名）绕过大小写不敏感文件系统的限制。

```bash
# 将 user.ts 改为 User.ts
tx-cli git-rename src/user/user.ts src/user/User.ts
```

#### `commit-fix <message...>`

根据 ones 上的信息（`#id` + `title` + `message`）自动转换为 `fix(#id): title` 格式提交 git commit。注意消息需要用双引号包裹。

```bash
tx-cli commit-fix "#532311 优化属性设置 https://ones.x.cn/abc"
```

#### `chat [question...]`

与大模型对话，支持任何 OpenAI 兼容接口（DeepSeek、Kimi、GLM、OpenAI 等）。

- 传入问题：单次问答，流式输出回答后退出
- 不传参数：进入多轮对话模式，持续输入问题对话，输入 `exit`/`quit` 或按 `Ctrl+C` 退出
- 工具调用默认开启、不可关闭：仅支持随版本内置发布的固定工具集，不支持运行时动态注册——`read_file`、`list_dir`、`glob`、`grep` 用于读取与检索本地文件，`web_search` 用于联网搜索实时信息；每次调用会打印 `→ 调用 ...` 提示
- 支持技能（skills）：扫描 `~/.tx-cli/skills`（用户级）与 `./.tx-cli/skills`（项目级，同名时项目级优先）中的 `SKILL.md` 技能手册，发现技能时自动装配 `load_skill` 工具，模型按需加载手册后按其指引执行；多轮对话中可用 `/skills` 查看技能清单
- 支持 MCP 服务器：在 `~/.tx-cli/config.json` 配置 `mcpServers` 段即可接入外部工具（详见下方 [MCP 服务器](#mcp-服务器)），`--no-mcp` 可按次禁用
- 单次问答与多轮对话均走 Responses API 无状态模式（要求所配置的服务支持该接口）：服务端不留存会话，多轮历史由本地维护并每轮全量发送
- 单轮问答的工具调用轮数上限为 8 轮，达到上限后模型将基于已有信息直接作答（黄字提示）

**选项：**

| 选项 | 说明 |
|---|---|
| `--think <level>` | 思考档位：`off` \| `low` \| `medium` \| `high`，仅影响本次对话 |
| `--no-mcp` | 本次对话禁用 MCP 服务器（缺省启用） |

**深度思考档位：**

统一档位 `off / low / medium / high`，按服务的协议风格自动翻译为对应请求字段，档位优先级：`--think` > 配置文件 `llm.thinkingLevel` > `medium`。

| 协议风格 | 适配服务 | 档位翻译方式 |
|---|---|---|
| `reasoning_effort` | OpenAI 官方（o 系列/gpt-5）、OpenRouter、vLLM 等 | `reasoning_effort: <档位>`，档位即强度 |
| `thinking` | 火山方舟（豆包）、智谱 GLM | `thinking: { type }`，仅开/关，low/medium/high 均按 enabled 折算 |
| `enable_thinking` | 阿里 Qwen DashScope 兼容模式 | `enable_thinking: true/false`，仅开/关 |
| `none` | DeepSeek 等 | 不下发思考字段（靠换 reasoner 类模型切换） |

风格按 `baseUrl` 自动推断（`volces.com`/`doubao`/`bigmodel.cn` → `thinking`，`dashscope.aliyuncs.com` → `enable_thinking`，其余 → `reasoning_effort`），推断不准时可用配置或环境变量覆盖。`off` 最为保守：`reasoning_effort`/`none` 风格下不下发任何思考字段，最大化兼容不支持思考扩展的服务。

模型返回深度思考内容时以暗色流式输出（以 `……` 标记开始），未返回思考内容则不产生任何额外输出。

多轮对话模式支持内联命令 `/think`：无参查看当前档位，带参切换（如 `/think high`，下一轮生效），非法档位提示后保留原档位。

首次使用需配置接入信息，任选一种方式：

1. 首次运行时的交互式引导，配置会保存到 `~/.tx-cli/config.json`（文件权限仅限当前用户读写）
2. 环境变量（优先级高于配置文件）：`TX_LLM_API_KEY`、`TX_LLM_BASE_URL`、`TX_LLM_MODEL`

| 环境变量 | 说明 |
|---|---|
| `TX_LLM_API_KEY` | API 密钥 |
| `TX_LLM_BASE_URL` | OpenAI 兼容接口地址 |
| `TX_LLM_MODEL` | 模型名称 |
| `TX_LLM_THINKING_LEVEL` | 全局默认思考档位：`off` \| `low` \| `medium` \| `high` |
| `TX_LLM_THINKING_STYLE` | 思考协议风格：`reasoning_effort` \| `thinking` \| `enable_thinking` \| `none` |

思考配置也可以写入 `~/.tx-cli/config.json` 的 `llm` 段（与环境变量同名字段，风格/档位可被环境变量覆盖）：

```jsonc
{
  "llm": {
    "apiKey": "sk-xxx",
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    // 全局默认思考档位，缺省 medium
    "thinkingLevel": "medium",
    // 思考协议风格，缺省按 baseUrl 推断
    "thinkingStyle": "reasoning_effort",
    // 可选：档位 → 服务端实际值的高级映射（适配仅支持部分档位的服务）
    "thinkingEffortMap": { "low": "high", "medium": "high", "high": "high" }
  },
  // MCP 服务器段，见下方说明，无则省略
  "mcpServers": {
    // 本地服务器：以子进程启动，配置中存在 command 即视为 stdio
    "fetch": {
      "command": "npx",
      "args": ["-y", "mcp-server-fetch"]
    },
    // 远程服务器：走 Streamable HTTP，配置中存在 url 即视为 http
    "search": {
      "url": "https://mcp.example.com/search",
      "headers": { "Authorization": "Bearer ${MY_TOKEN}" }
    }
  }
}
```

### MCP 服务器

在 `~/.tx-cli/config.json` 的 `mcpServers` 段配置外部工具服务器，对话时模型即可调用其工具（工具名带 `mcp__<服务器名>__<工具名>` 前缀，与内置工具区分）。格式与 Claude Desktop 的配置兼容：

| 字段 | 说明 |
|---|---|
| `command` / `args` / `env` | 本地服务器（stdio）：启动命令、参数、附加环境变量（与当前进程环境合并） |
| `url` / `headers` | 远程服务器（http）：服务器地址、附加请求头 |
| `type` | **可选**：`stdio` \| `http`，缺省时按字段自动推断——有 `command` 为 stdio，有 `url` 为 http |

- 字符串值支持 `${VAR}` 环境变量展开（如 `Bearer ${MY_TOKEN}`），未定义变量展开为空串
- 单个服务器连接失败只黄字告警，不影响其他服务器与本次对话；也可用 `tx-cli chat --no-mcp` 按次禁用全部 MCP 服务器

```bash
# 启用全部已配置的 MCP 服务器（缺省行为）
tx-cli chat 帮我抓取 https://example.com 的标题

# 本次对话禁用 MCP 服务器
tx-cli chat --no-mcp 怎么用 fs.rm 递归删除目录
```

```bash
# 单次问答（工具调用默认开启，可直接让模型读取本地文件）
tx-cli chat 当前目录 package.json 的 name 是什么

# 普通问答
tx-cli chat 怎么用 fs.rm 递归删除目录

# 指定思考档位
tx-cli chat --think high "证明这道题"

# 进入多轮对话（思考档位取配置默认，会话内 /think 随时切换）
tx-cli chat
tx-cli chat --think low

# 通过环境变量接入（以 DeepSeek 为例）
TX_LLM_API_KEY=sk-xxx TX_LLM_BASE_URL=https://api.deepseek.com/v1 TX_LLM_MODEL=deepseek-chat tx-cli chat
```

#### `agent [task...]`

让 AI Agent 执行任务（对标 Codex CLI / Claude Code 的执行模式）：模型可读写文件、执行 bash 命令，受沙箱档位与审批策略管控。

- 传入任务：单次执行，完成后退出
- 不传参数：进入多轮任务模式，持续输入任务，输入 `exit`/`quit` 或按 `Ctrl+C` 退出
- 工具带为全量：`chat` 的只读工具集之外额外装配 `bash` 与 `write_todos`（任务清单）工具，技能、MCP、Responses 无状态模式等机制与 `chat` 一致；多轮模式支持 `/think`、`/skills`、`/todos`、`/permissions` 内联命令
- 任务清单：对 3 步以上的任务，模型会先用 `write_todos` 建立清单并随进度更新（调用时打印清单视图：`☐` 待办 / `◐` 进行中 / `☑` 已完成），多轮模式可用 `/todos` 随时查看
- 单轮任务的工具调用轮数上限为 20 轮（chat 为 8 轮），达到上限后模型将基于已有信息直接作答（黄字提示）

**选项：**

| 选项 | 说明 |
|---|---|
| `--think <level>` | 思考档位：`off` \| `low` \| `medium` \| `high`，同 `chat` |
| `--no-mcp` | 本次任务禁用 MCP 服务器（缺省启用） |
| `--sandbox <level>` | bash 沙箱档位：`read-only`（默认，全禁写）\| `workspace-write`（可写工作空间）\| `danger-full-access`（无隔离） |
| `--approval <policy>` | 审批策略：`always-ask`（每次询问）\| `on-failure`（默认，沙箱拦截失败时询问）\| `never`（从不询问） |
| `--no-bash` | 本次任务禁用 bash 工具 |
| `--sandbox-missing <action>` | 沙箱在当前环境不可用时的处置：`deny`（默认，失败关闭）\| `allow`（降级为无隔离执行，规则与审批仍生效） |

沙箱档位与审批策略的优先级均为：命令行 > 环境变量（`TX_SANDBOX_LEVEL` / `TX_SANDBOX_APPROVAL`）> 配置文件 `sandbox` 段 > 内置默认，也可写入 `~/.tx-cli/config.json` 的 `sandbox` 段持久化（档位、审批、文件系统边界、权限规则等）。

```bash
# 单次执行任务（默认 read-only 沙箱，bash 仅能执行只读操作）
tx-cli agent 统计 src 下各目录的代码行数并汇总

# 允许写入工作空间，沙箱拦截失败时询问
tx-cli agent --sandbox workspace-write 修复 src/utils.ts 里的类型错误

# 多轮任务模式（会话内 /permissions 查看沙箱与权限状态）
tx-cli agent

# 禁用 bash，仅用只读工具与 MCP
tx-cli agent --no-bash 梳理这个仓库的模块结构
```

## TODO

- [x] 创建项目 `tx-cli create <project-name>`
- [x] 创建模块 `tx-cli add <module-name>`
- [x] server 命令（启用一个本地服务器）
- [x] git-rename 命令（git 重命名模块名称，支持大小写转换）
- [x] commit-fix 命令（格式化 ones 信息为 git commit）
- [x] chat 命令（与大模型对话，支持流式输出、多轮对话、工具调用与深度思考档位）
- [x] copy 命令（复制文件，支持过滤某些文件）`tx-cli copy <src> <dest> --filter <filter>`
- [x] agent 命令（让 AI Agent 执行任务，bash 受沙箱与审批管控，单次/多轮两种模式）