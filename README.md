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
- 工具调用默认开启、不可关闭：单次问答内置 `read_file` 等工具，模型可读取本地文件后再作答，每次调用会打印 `→ 调用 ...` 提示
- 单次问答：走 Chat Completions 接口
- 多轮对话：走 Responses API（要求所配置的服务支持该接口），采用服务端会话存储（store）+ `previous_response_id` 衔接上下文

**选项：**

| 选项 | 说明 |
|---|---|
| `--think <level>` | 思考档位：`off` \| `low` \| `medium` \| `high`，仅影响本次对话 |

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
  }
}
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

## TODO

- [x] 创建项目 `tx-cli create <project-name>`
- [x] 创建模块 `tx-cli add <module-name>`
- [x] server 命令（启用一个本地服务器）
- [x] git-rename 命令（git 重命名模块名称，支持大小写转换）
- [x] commit-fix 命令（格式化 ones 信息为 git commit）
- [x] chat 命令（与大模型对话，支持流式输出、多轮对话、工具调用与深度思考档位）
- [x] copy 命令（复制文件，支持过滤某些文件）`tx-cli copy <src> <dest> --filter <filter>`
- [ ] agent 命令（让大模型执行完成指定的任务）