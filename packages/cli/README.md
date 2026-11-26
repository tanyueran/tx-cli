# @tanyueran/cli

一个命令行工具，可以创建项目，添加模块，与大模型对话，以及支持一些简单的工具操作命令。

本包是 monorepo 的对外发布包，包含命令注册、终端 REPL 与终端 I/O 实现；会话编排、工具系统、沙箱与 LLM 接入等核心能力由 [`@tanyueran/agent-core`](https://github.com/tanyueran/tx-cli/tree/main/packages/agent-core) 提供。

## 包结构

```text
packages/cli/src/
├── cli.ts              # 进程入口：装配 program 并接管退出码
├── program/            # 命令注册与参数解析（每个命令一个文件）
├── conversation/       # 终端多轮入口与 REPL（输入帧、面板、斜杠命令）
├── channels/           # TTY Channel 实现：输入 / 输出 / 交互提示（颜色与表格在此映射）
└── services/           # CLI 专属服务：copy / server / commit-fix
```

## 安装

要求 Node.js >= 22.12.0。

```bash
npm install -g @tanyueran/cli
```

## 用法

```text
Usage: tx-cli [options] [command]

Options:
  -V, --version                               output the version number
  -h, --help                                  display help for command

Commands:
  create [project-name]                       创建项目
  add [module-name]                           添加模块
  copy [options] <src> <dest>                 复制文件或目录，支持过滤某些文件
  server [options]                            启动一个本地HTTP服务器
  git-rename <old-model-url> <new-model-url>  git重命名模块
  commit-fix <message...>                     根据 ones 信息生成 fix(#id): title 格式并提交
  chat [options] [question...]                与大模型轻量只读问答：单次问答或多轮对话
  agent [options] [task...]                   让 AI Agent 执行任务：单次执行或多轮任务模式
  help [command]                              display help for command
```

## 各命令说明

### `add [module-name]`

添加模块。不传模块名称时，会以交互式提示输入。

模块名称支持相对路径：生成目录基于**命令执行目录**解析（通过 `pnpm run dev` 等包装命令执行时，同样以调用处为准），模板中使用的名称只取路径最后一段。

```bash
tx-cli add user-profile

# 生成到 ./abc/aaa，组件名为 Aaa
tx-cli add ./abc/aaa
```

### `create [project-name]`

创建项目。不传项目名称时，会以交互式提示输入。

与 `add` 一致，项目名称支持相对路径，生成目录基于命令执行目录解析，模板中的项目名称取路径最后一段。

```bash
tx-cli create my-app

# 生成到 ./apps/admin，package.json 中的 name 为 admin
tx-cli create ./apps/admin
```

### `copy <src> <dest>`

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

### `server [options]`

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

### `git-rename <old-model-url> <new-model-url>`

git 重命名模块名称，主要用于 git 跟踪的文件的名称大小写转换。通过两次 mv（先改中间名再改目标名）绕过大小写不敏感文件系统的限制。

```bash
# 将 user.ts 改为 User.ts
tx-cli git-rename src/user/user.ts src/user/User.ts
```

### `commit-fix <message...>`

根据 ones 上的信息（`#id` + `title` + `message`）自动转换为 `fix(#id): title` 格式提交 git commit。注意消息需要用双引号包裹。

```bash
tx-cli commit-fix "#532311 优化属性设置 https://ones.x.cn/abc"
```

### `chat [question...]`

与大模型轻量只读问答，接入支持 Responses API 的 OpenAI 兼容接口。

- 传入问题：单次问答，流式输出回答后退出；不传参数（或纯空白，如 `tx-cli chat ""`）：进入多轮对话模式（`exit`/`quit` 退出）
- 工具调用默认开启：内置 `read_file`、`list_dir`、`glob`、`grep`、`web_search`、`web_fetch` 等只读固定工具集，可读取检索本地文件、联网搜索与抓取网页（`web_fetch` 仅支持公网 http/https、禁止内网地址，长页面可用 `offset` 续读；只读语义由代码强制：固定不装配 bash、MCP 与写侧工具，创建或修改文件请用 `agent`）
- 支持技能（skills）：自动扫描 `~/.tx-cli/skills` 与 `./.tx-cli/skills` 中的 `SKILL.md` 技能手册，多轮对话可用 `/skills` 查看清单
- 思考档位 `--think off|low|medium|high`（兜底 `low`），多轮对话可用 `/think` 随时切换
- 会话管理：多轮对话可用 `/clear` 清空历史与累计用量重新开始，`/export` 将当前会话导出为 Markdown 存档（写入当前目录）
- 上下文自动压缩：配置 `llm.context.maxContextTokens` 后，历史接近阈值时自动把早期轮次摘要压缩，长会话不再撑爆上下文（`chat` / `agent` 共用，单次与多轮均生效）
- 走 Responses API 无状态模式，多轮历史由本地维护；不支持 MCP，需要接入外部工具请用 `agent`
- 问题文本以 `-` 开头时，在命令选项与问题之间加 `--`，避免被解析为命令行选项

```bash
# 单次问答（可直接让模型读取本地文件）
tx-cli chat 当前目录 package.json 的 name 是什么

# 指定思考档位
tx-cli chat --think high "证明这道题"

# 进入多轮对话
tx-cli chat
```

首次使用需配置 `apiKey` / `baseUrl` / `model`（交互式引导或写入 `~/.tx-cli/config.json`）。深度思考协议适配、`llm` 段配置与分层合并等细节见 [chat 命令详解](https://github.com/tanyueran/tx-cli/blob/main/docs/CHAT.md)。

> 在克隆仓库中运行 `chat` / `agent` 前，请先审查 `.tx-cli/config.json`：项目配置会影响模型服务地址、MCP 服务器和部分沙箱实现选项。

### `agent [task...]`

让 AI Agent 执行任务（对标 Codex CLI / Claude Code 的执行模式）：在 `chat` 的只读工具集之外装配 `write_file` / `edit_file`、`write_todos` 与子 Agent 工具，按需装配 `bash`（受沙箱与审批管控）并接入 MCP 服务器。

- 传入任务：单次执行，完成后退出；不传参数（或纯空白，如 `tx-cli agent ""`）：进入多轮任务模式（支持 `/think`、`/skill`、`/skills`、`/clear`、`/export`、`/todos`、`/permissions`、`/help` 内联命令）
- 任务清单：对 3 步以上的任务，模型会先用 `write_todos` 建立清单并随进度更新
- 单轮任务的工具调用轮数上限为 40 轮（chat 为 8 轮），达到上限后基于已有信息直接作答
- 子 Agent：装配 `delegate_task` / `task_status` / `task_stop`，把边界清晰、过程会产生大量无关输出的子任务交给独立上下文的子 Agent，中间过程不进入主会话；默认同步等待结论，多轮模式可用 `background=true` 后台执行（最多 3 个并发），完成后自动注入结果
- 上下文自动压缩：与 `chat` 共用同一机制，配置 `llm.context.maxContextTokens` 后长任务会在阈值处自动摘要早期轮次

**选项：**

| 选项 | 说明 |
|---|---|
| `--think <level>` | 思考档位：`off` \| `low` \| `medium` \| `high`（兜底 `medium`），同 `chat` |
| `--sandbox <level>` | 工具执行与文件读写的沙箱档位：`read-only`（默认，全禁写）\| `workspace-write`（可写工作空间）\| `danger-full-access`（无隔离） |
| `--approval <policy>` | 审批策略：`always-ask` \| `on-failure`（默认）\| `never` |
| `--no-mcp` | 本次任务禁用 MCP 服务器（缺省启用） |
| `--no-bash` | 本次任务禁用 bash 工具 |
| `--sandbox-missing <action>` | 沙箱不可用时的处置：`deny`（默认，失败关闭）\| `allow`（bash 降级为无隔离执行） |

```bash
# 单次执行任务（默认 read-only 沙箱，bash 仅能执行只读操作）
tx-cli agent 统计 src 下各目录的代码行数并汇总

# 允许写入工作空间
tx-cli agent --sandbox workspace-write 修复 src/utils.ts 里的类型错误

# 任务文本以 - 开头时，用 -- 分隔选项与任务
tx-cli agent -- --更新文档

# 多轮任务模式
tx-cli agent
```

沙箱三档语义、`sandbox` 段配置、权限规则、信任目录、网络白名单、MCP 服务器配置与审批授权等细节见 [agent 命令详解](https://github.com/tanyueran/tx-cli/blob/main/docs/AGENT.md)。

## 详细文档

- [核心引擎与配置](https://github.com/tanyueran/tx-cli/tree/main/packages/agent-core)：会话机制、工具系统、沙箱与 `llm` 配置
- [chat 命令详解](https://github.com/tanyueran/tx-cli/blob/main/docs/CHAT.md)：工具与技能机制、深度思考档位与协议适配、`llm` 配置与分层合并
- [agent 命令详解](https://github.com/tanyueran/tx-cli/blob/main/docs/AGENT.md)：沙箱与审批、`sandbox` 段配置、权限规则、信任目录、网络白名单、MCP 服务器、审计日志
- [项目架构](https://github.com/tanyueran/tx-cli/blob/main/docs/ARCHITECTURE.md)：分层设计、对话链路与 agentic loop、沙箱四层模型、工具系统、扩展点
- [开发笔记](https://github.com/tanyueran/tx-cli/blob/main/docs/DESIGN-NOTES.md)：开发过程中的问题与设计取舍
