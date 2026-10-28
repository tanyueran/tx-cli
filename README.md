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
  chat [options] [question...]                与大模型轻量只读问答：传入问题为单次问答，不带参数进入多轮对话
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

与大模型轻量对话，支持任何 OpenAI 兼容接口（DeepSeek、Kimi、GLM、OpenAI 等）。

- 传入问题：单次问答，流式输出回答后退出
- 不传参数：进入多轮对话模式，持续输入问题对话，输入 `exit`/`quit` 或按 `Ctrl+C` 退出
- 工具调用默认开启、不可关闭：仅支持随版本内置发布的固定工具集，不支持运行时动态注册——`read_file`、`list_dir`、`glob`、`grep` 用于读取与检索本地文件，`write_file`、`edit_file` 用于创建与精确修改文件（受沙箱可写边界管控，默认 `read-only` 档下不可写），`web_search` 用于联网搜索实时信息；每次调用会打印 `→ 调用 ...` 提示
- 支持技能（skills）：扫描 `~/.tx-cli/skills`（用户级）与 `./.tx-cli/skills`（项目级，同名时项目级优先）中的 `SKILL.md` 技能手册，发现技能时自动装配 `load_skill` 工具，模型按需加载手册后按其指引执行；多轮对话中可用 `/skills` 查看技能清单
- 不支持 MCP：为保持轻量，`chat` 不装配 MCP 服务器，需要接入外部工具请用 `agent` 命令（详见下方 [MCP 服务器](#mcp-服务器)）
- 单次问答与多轮对话均走 Responses API 无状态模式（要求所配置的服务支持该接口）：服务端不留存会话，多轮历史由本地维护并每轮全量发送
- 单轮问答的工具调用轮数上限为 8 轮，达到上限后模型将基于已有信息直接作答（黄字提示）

**选项：**

| 选项 | 说明 |
|---|---|
| `--think <level>` | 思考档位：`off` \| `low` \| `medium` \| `high`，优先级：命令行 > 项目配置 > 全局配置（chat 最终默认 `low`，仅对本次对话生效） |

**深度思考档位：**

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

首次使用需配置接入信息，任选一种方式：

1. 首次运行时的交互式引导，配置会保存到 `~/.tx-cli/config.json`（文件权限仅限当前用户读写）
2. 直接写入配置文件的 `llm` 段：全局 `~/.tx-cli/config.json` 或项目 `<cwd>/.tx-cli/config.json`（同名字段项目配置优先）

**配置分层合并规则**（适用于 `llm`、`sandbox`、`mcp`、`mcpServers` 各段）：优先级为命令行选项 > 项目配置（`<cwd>/.tx-cli/config.json`）> 全局配置（`~/.tx-cli/config.json`）；标量字段高层覆盖低层，数组字段（如 `sandbox.rules.allow`、`mcp.rules.allow`、`sandbox.network.allowedDomains`、`sandbox.trustDirectories`）两层合并去重（全局在前、项目在后），`mcpServers` 按服务器名合并（同名以项目为准，启动时告警提示）。

**`llm` 段字段：**

| 字段 | 必填 | 说明 |
|---|---|---|
| `apiKey` | 是 | 服务 API Key，缺失时首次运行进入交互式引导 |
| `baseUrl` | 是 | OpenAI 兼容接口地址（Responses API 无状态模式） |
| `model` | 是 | 模型名 |
| `thinkingLevel` | 否 | 全局默认思考档位：`off` \| `low` \| `medium` \| `high`；未配置时随命令兜底（`chat` 为 `low`，`agent` 为 `medium`） |
| `thinkingStyle` | 否 | 思考协议风格：`reasoning_effort` \| `thinking` \| `enable_thinking` \| `none`，缺省按 `baseUrl` 推断（见上方协议风格表） |
| `thinkingEffortMap` | 否 | 档位 → 服务端实际值映射（适配仅支持部分档位的服务） |

`llm` 段与 `mcpServers` 段示例（写入 `~/.tx-cli/config.json`，项目配置可覆盖/合并同名字段）：

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

在配置文件的 `mcpServers` 段配置外部工具服务器，对话时模型即可调用其工具（工具名带 `mcp__<服务器名>__<工具名>` 前缀，与内置工具区分）。全局 `~/.tx-cli/config.json` 与项目 `<cwd>/.tx-cli/config.json` 均可配置，两层按服务器名合并，同名服务器以项目配置为准（启动时告警提示）。格式与 Claude Desktop 的配置兼容：

| 字段 | 说明 |
|---|---|
| `command` / `args` / `env` | 本地服务器（stdio）：启动命令、参数、附加环境变量（与当前进程环境合并） |
| `url` / `headers` | 远程服务器（http）：服务器地址、附加请求头 |
| `type` | **可选**：`stdio` \| `http`，缺省时按字段自动推断——有 `command` 为 stdio，有 `url` 为 http |

- 字符串值支持 `${VAR}` 环境变量展开（如 `Bearer ${MY_TOKEN}`），未定义变量展开为空串
- 单个服务器连接失败只黄字告警，不影响其他服务器与本次对话；也可用 `tx-cli agent --no-mcp` 按次禁用全部 MCP 服务器
- 工具审批按服务器粒度授权：首次调用可写工具时选择“本会话/始终允许该服务器”，同服务器其余工具不再逐个询问；选择“始终”会写入 `<cwd>/.tx-cli/config.json` 的 `mcp.rules.allow`（形如 `server__*`，加载时自动补全 `mcp__` 前缀）
- MCP 工具的放行/审批/拒绝规则配置在顶层 `mcp.rules` 段（与 `mcpServers` 平级），规则名可省略 `mcp__` 前缀；兼容旧写法（`sandbox.rules` 中的 `mcp__*` 规则仍生效），新配置建议统一写 `mcp.rules`
- 声明了 `readOnlyHint` 的只读 MCP 工具默认放行（`always-ask` 策略下仍会询问），其余工具默认需要审批；显式 `ask`/`deny` 规则始终优先
- MCP 仅在 `agent` 命令装配（`chat` 不支持），审批与授权规则与沙箱档位无关

```jsonc
// mcp.rules 示例：放行/审批/拒绝 MCP 工具（规则名可省略 mcp__ 前缀）
{
  "mcp": {
    "rules": {
      "allow": ["Chrome_DevTools_MCP__*"],
      "ask": ["github__create_issue"],
      "deny": ["untrusted_server__*"]
    }
  }
}
```

```bash
# 启用全部已配置的 MCP 服务器（缺省行为）
tx-cli agent 帮我抓取 https://example.com 的标题

# 本次任务禁用 MCP 服务器
tx-cli agent --no-mcp 整理当前目录结构并输出报告
```

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

#### `agent [task...]`

让 AI Agent 执行任务（对标 Codex CLI / Claude Code 的执行模式）：模型可读写文件、执行 bash 命令，受沙箱档位与审批策略管控。

- 传入任务：单次执行，完成后退出
- 不传参数：进入多轮任务模式，持续输入任务，输入 `exit`/`quit` 或按 `Ctrl+C` 退出
- 工具带为全量：在 `chat` 工具集之外额外装配 `bash`（受沙箱与审批管控）与 `write_todos`（任务清单）工具，并接入 MCP 服务器（`chat` 不装配），模型创建/修改文件优先使用 `write_file`（整体写入）与 `edit_file`（精确字符串替换，片段不唯一即失败）；技能、Responses 无状态模式等机制与 `chat` 一致；多轮模式支持 `/think`、`/skills`、`/todos`、`/permissions` 内联命令
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

沙箱档位与审批策略的优先级均为：命令行 > 项目配置 `sandbox` 段 > 全局配置 `sandbox` 段 > 内置默认（标量字段项目覆盖全局，数组字段两层合并去重），也可写入 `~/.tx-cli/config.json` 或 `<cwd>/.tx-cli/config.json` 的 `sandbox` 段持久化（档位、审批、文件系统边界、权限规则等）。

**`sandbox` 段完整字段**（全部可选，未配置取内置默认）：

| 字段 | 说明 | 默认值 |
|---|---|---|
| `enabled` | 沙箱总开关：`false` 时不装配 bash 工具，文件读写门卫也一并关闭 | `true` |
| `level` | 默认沙箱档位：`read-only` \| `workspace-write` \| `danger-full-access` | `read-only` |
| `approval` | 默认审批策略：`always-ask` \| `on-failure` \| `never` | `on-failure` |
| `provider` | 沙箱 Provider 名称（`srt` 为内置沙箱实现） | `srt` |
| `trustDirectories` | 信任目录列表（支持 `~`），见下方「信任目录」说明 | `[]` |
| `builtinDangerRules` | 内置危险命令类目拦截开关（如 `rm -rf /`），`false` 时关闭该层 | `true` |
| `filesystem.denyRead` | 追加的禁读路径模式（在档位默认之上叠加） | `[]` |
| `filesystem.denyWrite` | 追加的禁写路径模式（在档位默认之上叠加） | `[]` |
| `filesystem.writableRoots` | 追加的可写根目录（`workspace-write` 档生效） | `[]` |
| `network.allowedDomains` | bash 网络白名单域名（`workspace-write` 档生效，支持 `*.example.com` 通配，子域名不自动继承） | `[]` |
| `bash.enabled` | 是否装配 bash 工具（命令行 `--no-bash` 可按次关闭） | `true` |
| `bash.timeoutMs` | 单命令执行超时（毫秒） | `120000` |
| `rules.allow` / `rules.ask` / `rules.deny` | 权限规则（bash 命令、内置工具与 MCP 工具通用），见下方「权限规则」 | `[]` |
| `audit` | 是否写审批审计日志 | `true` |

**`sandbox` 段完整示例：**

```jsonc
{
  "sandbox": {
    "enabled": true,
    "level": "workspace-write",
    "approval": "on-failure",
    "provider": "srt",
    "trustDirectories": ["~/work"],
    "builtinDangerRules": true,
    "filesystem": {
      "denyRead": ["~/.config"],
      "denyWrite": ["*.key"],
      "writableRoots": ["~/data"]
    },
    "network": { "allowedDomains": ["registry.npmmirror.com", "github.com", "*.githubusercontent.com"] },
    "bash": { "enabled": true, "timeoutMs": 120000 },
    "rules": {
      "allow": ["Bash(git status)", "Bash(npm run:*)"],
      "ask": ["Bash(git push:*)"],
      "deny": ["Bash(rm -rf:*)", "Bash(sudo:*)"]
    },
    "audit": true
  },
  "mcp": {
    "rules": {
      "allow": ["github__*"]
    }
  }
}
```

**沙箱三档语义：**

| 档位 | 文件写入 | bash 网络 | 读侧限制 |
|---|---|---|---|
| `read-only` | 全禁写 | 全禁网 | 默认禁读 `~/.ssh`、`~/.aws`、`~/.gnupg` 等凭据目录，可经 `filesystem.denyRead` 追加 |
| `workspace-write` | 仅可写当前目录、系统临时目录与 `filesystem.writableRoots`；`.env`、`*.pem` 等敏感文件仍禁写，可经 `filesystem.denyWrite` 追加 | 仅放行 `network.allowedDomains` 白名单域名（allow-only） | 同 `read-only` 的禁读限制 |
| `danger-full-access` | 不限 | 不限 | 无（无隔离） |

**权限规则（rules）：**

- 判定优先级：`deny`（含内置危险类目）> `ask` > `allow` > 档位默认；bash 复合命令逐段判定，任一段命中 deny 则整条拒绝，任一段命中 ask 则整条进入审批
- 规则语法：`工具名` 整工具生效（如 `web_search`）；`工具名(模式)` 细粒度生效（如 `Bash(git push:*)`、`Read(/src/**)`）；规则名不区分大小写，支持 `Read`、`Write`、`Edit`、`ListDir`、`WebSearch` 等短名（自动映射到内部工具名）
- 模式三种写法：`cmd` 精确匹配、`prefix:*` 前缀匹配、含 `*` 的 glob 通配
- `sandbox.rules` 管 bash 与内置工具；MCP 工具规则写在顶层 `mcp.rules` 段，支持 `服务器名__*` 通配整组放行/审批/拒绝（兼容旧写法 `mcp__服务器名__*`，两层规则加载后合并判定）
- `read-only` 档下，除声明无副作用的只读检索工具（`web_search`，口径对齐 MCP 只读工具）默认放行外，其余联网工具未命中规则时默认进入审批（该档承诺禁网，进程内网络调用不受沙箱边界约束）
- 审批时选择「始终允许」会把授权规则写入项目配置 `<cwd>/.tx-cli/config.json`（MCP 授权落 `mcp.rules.allow`，其余落 `sandbox.rules.allow`，仅对当前项目生效）

**信任目录（trustDirectories）：**

- 来自配置文件的 `danger-full-access` 档与 `never` 审批策略，仅在当前工作目录位于任一信任目录内（含其子目录）时生效，否则自动降级（full → `workspace-write`、never → `on-failure`）并黄字告警，防止误配置放大权限
- 命令行显式指定（`--sandbox danger-full-access`、`--approval never`）不受信任目录限制

**审计日志（audit）：**

- 默认开启：每次拦截与审批判定追加一行 JSON 到 `~/.tx-cli/sandbox-audit.jsonl`，便于事后追溯；`"audit": false` 关闭

**沙箱网络白名单（allow-only）**：bash 命令的所有网络访问都经沙箱代理强制走域名白名单，未放行的域名会被代理以 `HTTP 403` 拒绝（空白名单 = 全禁网）。`workspace-write` 档若需 `npm install`、`curl`、`git push` 等联网操作，须显式放行域名（支持 `*.example.com` 通配，子域名不自动继承）：

```json
{
  "sandbox": {
    "level": "workspace-write",
    "network": {
      "allowedDomains": ["registry.npmmirror.com", "github.com", "*.githubusercontent.com"]
    }
  }
}
```

> 注意：`web_search` 工具是进程内网络请求，不经沙箱代理，不受此白名单管控。

审批策略与 MCP：MCP 工具不经 OS 沙箱，判定独立于 `--sandbox` 档位——声明 `readOnlyHint` 的只读工具默认放行（`always-ask` 下仍询问）；可写工具首次调用时提供服务器级授权选项，`never` 策略下无显式 allow 规则则拒绝。授权粒度与配置示例见下方 [MCP 服务器](#mcp-服务器)。

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