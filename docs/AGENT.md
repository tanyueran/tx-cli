# agent 命令详解

让 AI Agent 执行任务（对标 Codex CLI / Claude Code 的执行模式）：模型可读写文件、执行 bash 命令，受沙箱档位与审批策略管控。

## 基本用法

- 传入任务：单次执行，完成后退出
- 不传参数：进入多轮任务模式，持续输入任务，输入 `exit`/`quit` 或按 `Ctrl+C` 退出
- 工具带为全量：在 `chat` 工具集之外额外装配 `bash`（受沙箱与审批管控）与 `write_todos`（任务清单）工具，并接入 MCP 服务器（`chat` 不装配），模型创建/修改文件优先使用 `write_file`（整体写入）与 `edit_file`（精确字符串替换，片段不唯一即失败）；技能、Responses 无状态模式等机制与 `chat` 一致（详见 [chat 命令详解](./CHAT.md)）；多轮模式支持 `/think`、`/skills`、`/todos`、`/permissions` 内联命令
- 任务清单：对 3 步以上的任务，模型会先用 `write_todos` 建立清单并随进度更新（调用时打印清单视图：`☐` 待办 / `◐` 进行中 / `☑` 已完成），多轮模式可用 `/todos` 随时查看
- 单轮任务的工具调用轮数上限为 40 轮（chat 为 8 轮），达到上限后模型将基于已有信息直接作答（黄字提示）

**选项：**

| 选项 | 说明 |
|---|---|
| `--think <level>` | 思考档位：`off` \| `low` \| `medium` \| `high`，同 `chat` |
| `--no-mcp` | 本次任务禁用 MCP 服务器（缺省启用） |
| `--sandbox <level>` | bash 沙箱档位：`read-only`（默认，全禁写）\| `workspace-write`（可写工作空间）\| `danger-full-access`（无隔离） |
| `--approval <policy>` | 审批策略：`always-ask`（每次询问）\| `on-failure`（默认，沙箱拦截失败时询问）\| `never`（从不询问） |
| `--no-bash` | 本次任务禁用 bash 工具 |
| `--sandbox-missing <action>` | 沙箱在当前环境不可用时的处置：`deny`（默认，失败关闭）\| `allow`（降级为无隔离执行，规则与审批仍生效） |

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

## 沙箱

沙箱档位与审批策略的优先级均为：命令行 > 项目配置 `sandbox` 段 > 全局配置 `sandbox` 段 > 内置默认（能力感知合并：项目配置仅可收紧沙箱能力，放宽类字段被忽略并告警，收紧类数组并集叠加，详见下方「项目沙箱配置」），也可写入 `~/.tx-cli/config.json` 或 `<cwd>/.tx-cli/config.json` 的 `sandbox` 段持久化（档位、审批、文件系统边界、权限规则等）。

### 三档语义

| 档位 | 文件写入 | bash 网络 | 读侧限制 |
|---|---|---|---|
| `read-only` | 全禁写 | 全禁网 | 默认禁读 `~/.ssh`、`~/.aws`、`~/.gnupg` 等凭据目录，可经 `filesystem.denyRead` 追加 |
| `workspace-write` | 仅可写当前目录、系统临时目录与 `filesystem.writableRoots`；`.env`、`*.pem` 等敏感文件仍禁写，可经 `filesystem.denyWrite` 追加 | 仅放行 `network.allowedDomains` 白名单域名（allow-only） | 同 `read-only` 的禁读限制 |
| `danger-full-access` | 不限 | 不限 | 无（无隔离） |

### `sandbox` 段完整字段

全部可选，未配置取内置默认：

| 字段 | 说明 | 默认值 |
|---|---|---|
| `enabled` | 沙箱总开关：`false` 时不装配 bash 工具，文件读写门卫也一并关闭 | `true` |
| `level` | 默认沙箱档位：`read-only` \| `workspace-write` \| `danger-full-access` | `read-only` |
| `approval` | 默认审批策略：`always-ask` \| `on-failure` \| `never` | `on-failure` |
| `provider` | 沙箱 Provider 名称（`srt` 为内置沙箱实现） | `srt` |
| `trustDirectories` | 信任目录列表（支持 `~`，仅全局配置生效，项目配置中忽略），见下方「信任目录」说明 | `[]` |
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

### 权限规则（rules）

- 判定优先级：`deny`（含内置危险类目）> `ask` > `allow` > 档位默认；bash 复合命令逐段判定，任一段命中 deny 则整条拒绝，任一段命中 ask 则整条进入审批
- 规则语法：`工具名` 整工具生效（如 `web_search`）；`工具名(模式)` 细粒度生效（如 `Bash(git push:*)`、`Read(/src/**)`）；规则名不区分大小写，支持 `Read`、`Write`、`Edit`、`ListDir`、`WebSearch` 等短名（自动映射到内部工具名）
- 模式三种写法：`cmd` 精确匹配、`prefix:*` 前缀匹配、含 `*` 的 glob 通配
- `sandbox.rules` 管 bash 与内置工具；MCP 工具规则写在顶层 `mcp.rules` 段，支持 `服务器名__*` 通配整组放行/审批/拒绝（兼容旧写法 `mcp__服务器名__*`，两层规则加载后合并判定）
- `read-only` 档下，除声明无副作用的只读检索工具（`web_search`，口径对齐 MCP 只读工具）默认放行外，其余联网工具未命中规则时默认进入审批（该档承诺禁网，进程内网络调用不受沙箱边界约束）
- 审批时选择「始终允许」会把授权规则写入项目配置 `<cwd>/.tx-cli/config.json`（MCP 授权落 `mcp.rules.allow`，其余落 `sandbox.rules.allow`，仅对当前项目生效）

### 信任目录（trustDirectories）

- 来自配置文件的 `danger-full-access` 档与 `never` 审批策略，仅在当前工作目录位于任一信任目录内（含其子目录）时生效；否则交互启动时会先询问是否信任当前目录——确认后写入全局配置的 `trustDirectories`（同目录后续启动不再询问），拒绝或非交互环境则自动降级（full → `workspace-write`、never → `on-failure`）并黄字告警，防止 clone 下来的仓库借自带配置自证信任、获得无审批执行权限
- 命令行显式指定（`--sandbox danger-full-access`、`--approval never`）不受信任目录限制
- 信任目录仅可由全局 `~/.tx-cli/config.json` 提供：项目配置中的 `trustDirectories` 会被忽略并告警

### 项目沙箱配置（能力感知合并）

- 项目 `<cwd>/.tx-cli/config.json` 的 sandbox 段仅可收紧沙箱能力、不可放宽：放宽档位/审批、关闭沙箱/内置危险规则/审计、开启 bash，以及 `trustDirectories`、`filesystem.writableRoots`、`network.allowedDomains` 等放宽类字段来自项目配置时会被忽略并告警
- 收紧类字段正常生效：`filesystem.denyRead` / `denyWrite`、`rules.ask` / `deny` 并集叠加，`rules.allow` 保持并集（承载会话中「始终允许」授权的落盘），`provider` / `bash.timeoutMs` 等中性选项项目覆盖全局

### 审计日志（audit）

- 默认开启：每次拦截与审批判定追加一行 JSON 到 `~/.tx-cli/sandbox-audit.jsonl`，便于事后追溯；`"audit": false` 关闭

### 沙箱网络白名单（allow-only）

bash 命令的所有网络访问都经沙箱代理强制走域名白名单，未放行的域名会被代理以 `HTTP 403` 拒绝（空白名单 = 全禁网）。`workspace-write` 档若需 `npm install`、`curl`、`git push` 等联网操作，须显式放行域名（支持 `*.example.com` 通配，子域名不自动继承）：

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

> 注意：代理通过 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量下发，`curl` 会读取、Node 的 `fetch` 默认不读取；CLI 会为 bash 子进程注入 `NODE_USE_ENV_PROXY=1`（用户已显式设置时不覆盖），因此 `node` 脚本联网同样受白名单管控，无需在命令里自行加前缀。

> 注意：`web_search` 工具是进程内网络请求，不经沙箱代理，不受此白名单管控。

## MCP 服务器

在配置文件的 `mcpServers` 段配置外部工具服务器，对话时模型即可调用其工具（工具名带 `mcp__<服务器名>__<工具名>` 前缀，与内置工具区分）。全局 `~/.tx-cli/config.json` 与项目 `<cwd>/.tx-cli/config.json` 均可配置，两层按服务器名合并，同名服务器以项目配置为准（启动时告警提示）。格式与 Claude Desktop 的配置兼容：

| 字段 | 说明 |
|---|---|
| `command` / `args` / `env` | 本地服务器（stdio）：启动命令、参数、附加环境变量（与当前进程环境合并） |
| `url` / `headers` | 远程服务器（http）：服务器地址、附加请求头 |
| `type` | **可选**：`stdio` \| `http`，缺省时按字段自动推断——有 `command` 为 stdio，有 `url` 为 http |

- 字符串值支持 `${VAR}` 环境变量展开（如 `Bearer ${MY_TOKEN}`），未定义变量展开为空串
- 单个服务器连接失败只黄字告警，不影响其他服务器与本次对话；也可用 `tx-cli agent --no-mcp` 按次禁用全部 MCP 服务器
- 工具审批按服务器粒度授权：首次调用可写工具时选择"本会话/始终允许该服务器"，同服务器其余工具不再逐个询问；选择"始终"会写入 `<cwd>/.tx-cli/config.json` 的 `mcp.rules.allow`（形如 `server__*`，加载时自动补全 `mcp__` 前缀）
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

审批策略与 MCP：MCP 工具不经 OS 沙箱，判定独立于 `--sandbox` 档位——声明 `readOnlyHint` 的只读工具默认放行（`always-ask` 下仍询问）；可写工具首次调用时提供服务器级授权选项，`never` 策略下无显式 allow 规则则拒绝。授权粒度与配置示例见上方 [MCP 服务器](#mcp-服务器)。
