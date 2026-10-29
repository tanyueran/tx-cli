# @tanyueran/cli

一个命令行工具，可以创建项目，添加模块，与大模型对话，以及支持一些简单的工具操作命令

## 安装

```bash
npm install -g @tanyueran/cli
```

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
  chat [options] [question...]                与大模型轻量只读问答：传入问题为单次问答，不带参数进入多轮对话
  agent [options] [task...]                   让 AI Agent 执行任务：传入任务为单次执行，不带参数进入多轮任务模式
  help [command]                              display help for command
```

## 各命令说明

### `add [module-name]`

添加模块。不传模块名称时，会以交互式提示输入。

```bash
tx-cli add user-profile
```

### `create [project-name]`

创建项目。不传项目名称时，会以交互式提示输入。

```bash
tx-cli create my-app
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

与大模型轻量只读问答，支持任何 OpenAI 兼容接口（DeepSeek、Kimi、GLM、OpenAI 等）。

- 传入问题：单次问答，流式输出回答后退出；不传参数：进入多轮对话模式（`exit`/`quit` 退出）
- 工具调用默认开启：内置 `read_file`、`glob`、`grep`、`write_file`、`edit_file`、`web_search` 等固定工具集，可读取检索本地文件、联网搜索（写文件受沙箱边界管控，`read-only` 档下不可写）
- 支持技能（skills）：自动扫描 `~/.tx-cli/skills` 与 `./.tx-cli/skills` 中的 `SKILL.md` 技能手册，多轮对话可用 `/skills` 查看清单
- 思考档位 `--think off|low|medium|high`（兜底 `low`），多轮对话可用 `/think` 随时切换
- 走 Responses API 无状态模式，多轮历史由本地维护；不支持 MCP，需要接入外部工具请用 `agent`

```bash
# 单次问答（可直接让模型读取本地文件）
tx-cli chat 当前目录 package.json 的 name 是什么

# 指定思考档位
tx-cli chat --think high "证明这道题"

# 进入多轮对话
tx-cli chat
```

首次使用需配置 `apiKey` / `baseUrl` / `model`（交互式引导或写入 `~/.tx-cli/config.json`）。深度思考协议适配、`llm` 段配置与分层合并等细节见 [docs/CHAT.md](docs/CHAT.md)。

### `agent [task...]`

让 AI Agent 执行任务（对标 Codex CLI / Claude Code 的执行模式）：在 `chat` 工具集之外额外装配 `bash`（受沙箱与审批管控）与 `write_todos`（任务清单），并接入 MCP 服务器。

- 传入任务：单次执行，完成后退出；不传参数：进入多轮任务模式（支持 `/think`、`/skills`、`/todos`、`/permissions` 内联命令）
- 任务清单：对 3 步以上的任务，模型会先用 `write_todos` 建立清单并随进度更新
- 单轮任务的工具调用轮数上限为 40 轮（chat 为 8 轮），达到上限后基于已有信息直接作答

**选项：**

| 选项 | 说明 |
|---|---|
| `--think <level>` | 思考档位：`off` \| `low` \| `medium` \| `high`（兜底 `medium`），同 `chat` |
| `--sandbox <level>` | bash 沙箱档位：`read-only`（默认，全禁写）\| `workspace-write`（可写工作空间）\| `danger-full-access`（无隔离） |
| `--approval <policy>` | 审批策略：`always-ask` \| `on-failure`（默认）\| `never` |
| `--no-mcp` | 本次任务禁用 MCP 服务器（缺省启用） |
| `--no-bash` | 本次任务禁用 bash 工具 |
| `--sandbox-missing <action>` | 沙箱不可用时的处置：`deny`（默认，失败关闭）\| `allow`（降级无隔离执行） |

```bash
# 单次执行任务（默认 read-only 沙箱，bash 仅能执行只读操作）
tx-cli agent 统计 src 下各目录的代码行数并汇总

# 允许写入工作空间
tx-cli agent --sandbox workspace-write 修复 src/utils.ts 里的类型错误

# 多轮任务模式
tx-cli agent
```

沙箱三档语义、`sandbox` 段配置、权限规则、信任目录、网络白名单、MCP 服务器配置与审批授权等细节见 [docs/AGENT.md](docs/AGENT.md)。

## 详细文档

- [chat 命令详解](docs/CHAT.md)：工具与技能机制、深度思考档位与协议适配、`llm` 配置与分层合并
- [agent 命令详解](docs/AGENT.md)：沙箱与审批、`sandbox` 段配置、权限规则、信任目录、网络白名单、MCP 服务器、审计日志
- [项目架构](docs/ARCHITECTURE.md)：分层设计、对话链路与 agentic loop、沙箱四层模型、工具系统、扩展点
- [开发笔记](docs/DESIGN-NOTES.md)：开发过程中的问题与设计取舍（思考档位适配、协议选型、权限安全、技能与 MCP 等）

## TODO

- [x] 创建项目 `tx-cli create <project-name>`
- [x] 创建模块 `tx-cli add <module-name>`
- [x] server 命令（启用一个本地服务器）
- [x] git-rename 命令（git 重命名模块名称，支持大小写转换）
- [x] commit-fix 命令（格式化 ones 信息为 git commit）
- [x] chat 命令（与大模型对话，支持流式输出、多轮对话、工具调用与深度思考档位）
- [x] copy 命令（复制文件，支持过滤某些文件）`tx-cli copy <src> <dest> --filter <filter>`
- [x] agent 命令（让 AI Agent 执行任务，bash 受沙箱与审批管控，单次/多轮两种模式）
- [ ] 子 Agent（agent 派生独立上下文的子任务，仅摘要结果回传主上下文，避免中间输出污染主会话）
- [ ] 子 Agent 并行编排（一次派生多个子 agent 并行执行独立子任务并汇总结果）
- [ ] 上下文自动压缩（历史超阈值时摘要压缩早期轮次，长任务不爆上下文）
- [ ] `/clear` 内联命令（一键清空当前会话历史重开）
- [ ] Token 用量统计（每轮/累计 token 与费用估算，REPL 就绪面板展示）
- [ ] `/export` 会话导出（当前会话导出为 Markdown 存档）
- [ ] `web_fetch` 工具（抓取 URL 网页转 Markdown 给模型，补齐联网闭环）
- [ ] 回答 Markdown 渲染（REPL 中正文按 Markdown 渲染）
