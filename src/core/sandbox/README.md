# Sandbox 沙箱模块

沙箱模块负责在模型调用工具时建立一套完整的权限控制机制：在会话启动时确定权限边界，在每次工具调用时判断调用意图，必要时请求用户审批，随后按工具类型执行隔离，并记录审计信息。

它不只是“包装 Bash 命令”，而是由配置、规则、审批、执行边界和审计共同组成的运行时安全层。

> 整体架构与权限链路（四层模型）见 [docs/ARCHITECTURE.md](../../../docs/ARCHITECTURE.md)，本文聚焦沙箱模块内部的实现细节。

## 1. 核心思想

可以将整个模块概括为：

> 启动时确定权限，调用时判断意图，不确定就审批，按工具类型实施边界，最后记录结果。

### 1.1 权限上限与调用意图分离

沙箱档位决定本次会话最多具备什么能力，规则决定某一次具体调用如何处理。

例如，`workspace-write` 表示允许写入工作区，但不代表每条写命令都自动放行；具体命令仍可能需要经过规则和审批。

### 1.2 判定与执行分离

规则层只回答 `allow`、`ask` 或 `deny`，不负责真正执行命令。

执行层根据工具类型选择不同边界：

- Bash 命令由 Provider 包装并隔离执行；
- Read、Write 等进程内文件工具由应用层路径边界检查。

这种分离使规则逻辑可以独立测试，也允许替换不同的沙箱后端。

### 1.3 默认安全

模块在多个位置采用默认安全策略：

- Provider 缺失或不可用时，默认失败关闭，而不是静默直通；
- 非交互环境无法处理 `ask` 时，默认拒绝；
- 非信任目录中的危险文件配置会被降级；
- 项目配置只能收紧全局能力，不能自行扩大权限；
- 沙箱缺失后降级直通必须由用户显式允许。

### 1.4 会话级协调

一个会话持有一个 `SandboxContext`。它保存生效配置、规则、档位、审批策略和 Provider，并负责：

- 规则判定与审批协调；
- 会话内授权记忆；
- 文件系统边界检查；
- 串行工具队列；
- 审计记录；
- 会话结束时的资源释放。

### 1.5 可审计

关键决策和执行结果都可以写入 JSONL 审计日志，便于回答：

- 调用了什么工具或命令；
- 为什么被允许或拒绝；
- 用户作出了什么审批选择；
- 是否发生沙箱违规；
- 是否脱离沙箱重跑。

## 2. 核心概念

| 概念 | 回答的问题 | 典型值或实现 |
| --- | --- | --- |
| 沙箱档位 | 本次会话最多允许做什么 | `read-only`、`workspace-write`、`danger-full-access` |
| 规则 | 某条具体命令或工具调用如何处理 | `allow`、`ask`、`deny` |
| 审批策略 | 不确定或失败时何时询问 | `always-ask`、`on-failure`、`never` |
| Provider | 使用什么技术隔离 Bash 子进程 | `srt`、`landlock`、`noop` |
| `TierConfig` | 当前档位的实际边界是什么 | 可写根、禁读路径、禁写模式、网络白名单 |
| 授权 | 已批准的同类调用如何复用 | 会话内存授权、项目配置持久授权 |
| 审计 | 调用过程中实际发生了什么 | JSONL 审计记录 |

这些概念彼此独立。例如，沙箱档位不决定审批时机，Provider 也不负责决定某条命令是否应该被允许。

## 3. 目录职责

```text
sandbox/
├── index.ts                  # 对外统一入口
├── types.ts                  # 公共类型、接口和运行时契约
│
├── bootstrap/                # 会话启动时的一次性装配
│   ├── create-context.ts     # 装配主流程
│   ├── options.ts            # CLI 与配置优先级合并
│   └── trust.ts              # 目录信任、危险配置降级与信任持久化
│
├── config/                   # 配置定义与读取
│   ├── schema.ts             # 配置结构、合法值和默认值
│   └── load.ts               # 全局/项目配置读取、校验与合并
│
├── policy/                   # 纯规则判断
│   ├── evaluate.ts           # 输出 allow / ask / deny
│   ├── syntax.ts             # 规则语法解析与匹配
│   └── danger.ts             # 内置危险命令识别
│
├── runtime/                  # 每次工具调用时的运行时协调
│   ├── sandbox-context.ts    # 会话级协调核心
│   ├── interactive-approver.ts
│   ├── approval-grants.ts    # 持久授权写入
│   ├── audit.ts              # JSONL 审计写入
│   ├── tier-config.ts        # 构造档位边界配置
│   └── fs-boundary.ts        # 进程内文件读写边界
│
├── providers/                # Bash 隔离后端
│   ├── registry.ts
│   ├── srt.ts
│   ├── landlock.ts
│   └── noop.ts
│
└── utils/                    # 无业务状态的纯工具
    ├── command.ts
    ├── glob.ts
    ├── path.ts
    └── shell.ts
```

## 4. 会话启动流程

入口是 `bootstrap/create-context.ts` 中的 `createSandboxContext()`。

```text
读取全局/项目配置
  → 应用 CLI 参数
  → 判断是否启用沙箱
  → 检查目录信任并处理危险配置
  → 选择并初始化 Provider
  → 创建 SandboxContext
```

### 4.1 配置合并

生效配置的优先级为：

```text
CLI 显式参数 > 项目配置 > 全局配置 > 默认值
```

项目配置用于收紧当前项目的权限，不能覆盖全局配置中的安全限制来扩大能力。

### 4.2 目录信任

当配置文件来源的以下危险配置出现在非信任目录时，需要额外处理：

- `danger-full-access`；
- `approval: never`。

交互环境可以请求用户确认信任；未确认信任时：

- `danger-full-access` 降为 `workspace-write`；
- `never` 降为 `on-failure`。

CLI 显式传入的值代表用户当次意图，不走这条文件配置降级路径。

### 4.3 Provider 选择

- `danger-full-access` 使用 `noop`，命令不经过隔离包装；
- 其他档位使用配置指定的 Provider；
- Provider 未知、不可用或初始化失败时，默认失败关闭；
- 只有显式配置 `sandbox-missing=allow`，才允许降级为 `noop` 直通执行。

即使降级为 `noop`，规则与审批仍然生效，但操作系统级隔离能力会消失。

### 4.4 Bash 开关与沙箱上下文解耦

关闭 Bash 工具不等于关闭沙箱上下文。

在只读问答等无 Bash 会话中，可以不装配 Bash、不初始化 Provider，但仍保留 `SandboxContext`，继续保护进程内文件工具。

## 5. 单次工具调用流程

工具不会直接执行，而是先经过权限包装层。

```text
生成工具规则键
  → SandboxContext.guard()
  → policy 判定
  → 必要时用户审批
  → 工具类型对应的边界检查
  → 执行
  → 结果处理与审计
```

例如，Bash 工具会生成类似 `bash(git status)` 的规则键；非 Bash 工具则使用相应的工具规则键。

Bash 等串行工具会把“判定、审批和执行”放入会话串行队列，避免多个危险操作并发改变系统状态。

## 6. 规则判定

`policy/evaluate.ts` 是规则判定核心。

### 6.1 Bash 命令

Bash 命令先拆分顶层复合命令，再逐段判断。只要任一段命中拒绝条件，整条命令就会被拒绝。

整体优先级为：

```text
内置危险规则 / 用户 deny
  > ask
  > allow
  > 当前档位和审批策略的默认行为
```

因此，`安全命令 && 危险命令` 不会因为前半段安全而整体放行。

空命令直接拒绝。

### 6.2 非 Bash 工具

非 Bash 工具按工具规则键进行匹配，仍使用 `allow`、`ask`、`deny` 三类规则。

### 6.3 规则通过不等于执行一定成功

规则放行只表示通过应用层门卫。实际执行仍可能被以下边界阻断：

- Provider 的文件系统或网络隔离；
- `fs-boundary` 的路径检查；
- 操作系统权限；
- 命令自身错误。

## 7. 审批与授权复用

当判定结果为 `ask` 时，交互环境会向用户提供以下选择：

| 选择 | 含义 |
| --- | --- |
| 一次允许 | 只放行当前调用 |
| 本会话允许 | 将授权加入当前会话内存，后续同类调用复用 |
| 始终允许 | 写入当前项目配置，同时更新当前会话规则 |
| 拒绝 | 阻断调用并记录审计 |

持久授权按工具类型写入：

- MCP 工具写入 `mcp.rules.allow`；
- Bash 和其他内置工具写入 `sandbox.rules.allow`。

授权归属于当前项目，不自动跨项目生效。

非交互环境无法询问时，`ask` 默认拒绝，避免后台任务静默等待或绕过审批。

## 8. 两条执行边界

### 8.1 Bash：Provider 隔离

Bash 放行的执行顺序为：

```text
provider.wrapCommand()
  → spawnShell()
  → provider.annotateStderr()
  → 返回退出码、输出和违规事件
```

Provider 实现：

| Provider | 作用 |
| --- | --- |
| `srt` | 接入 `@anthropic-ai/sandbox-runtime`，支持命令包装、违规标注和结构化违规事件 |
| `landlock` | 在 Linux 上通过外部 `landlock-exec` 包装命令 |
| `noop` | 不做隔离，原样传递命令和输出 |

Provider 只负责隔离 Bash 子进程，不负责进程内文件工具。

### 8.2 文件工具：应用层路径边界

Read、Write 等工具直接运行在 CLI 进程内，无法依靠 Bash Provider 自动隔离，因此需要 `fs-boundary.ts`：

- 读取采用禁止列表思路；
- 写入采用允许列表，并叠加禁止写入模式；
- `danger-full-access` 下应用层文件边界直接放行。

`tier-config.ts` 负责把档位和配置转换为实际边界：

- `read-only`：不允许写入，并设置默认敏感目录禁读；
- `workspace-write`：允许写入工作区、临时目录及配置的可写根，同时保留敏感文件禁写规则；
- `danger-full-access`：不设置应用层读写限制。

## 9. 失败与升级

`on-failure` 不是“普通命令失败就脱离沙箱重跑”。

只有同时满足以下条件时，才可能询问是否升级：

1. 命令非零退出；
2. 存在结构化沙箱违规事件；
3. 当前审批策略允许失败升级；
4. 当前环境可以交互。

普通非零退出和命令超时不会自动触发升级。

升级批准后执行的是未包装的原命令，并在审计中记录 `escalated`，因此它是显式绕过隔离的高权限操作。

## 10. 审计

审计统一由 `SandboxContext.recordAudit()` 补充会话信息，再交给 `runtime/audit.ts` 追加写入。

默认审计文件：

```text
~/.tx-cli/sandbox-audit.jsonl
```

审计文件权限为 `0o600`。写入失败只产生警告，不应反过来阻断工具执行。

当 `sandbox.audit=false` 时关闭审计写入。

## 11. 推荐阅读顺序

为了先掌握主干再深入细节，建议按以下顺序阅读：

1. `types.ts`、`config/schema.ts`：理解核心词汇和默认值；
2. `bootstrap/create-context.ts`：理解启动主流程；
3. `bootstrap/options.ts`、`bootstrap/trust.ts`：理解参数优先级和目录信任；
4. `runtime/sandbox-context.ts`：理解运行时协调核心；
5. `policy/evaluate.ts`：理解 `allow / ask / deny` 如何产生；
6. `policy/syntax.ts`、`policy/danger.ts`、`utils/command.ts`：理解规则匹配细节；
7. `runtime/interactive-approver.ts`、`runtime/approval-grants.ts`：理解审批与授权复用；
8. `runtime/tier-config.ts`、`runtime/fs-boundary.ts`：理解应用层边界；
9. 外部调用方 `tools/permission.ts`、`tools/builtin/bash.ts`：理解工具如何接入；
10. `providers/noop.ts`，再读 `srt.ts`、`landlock.ts`：从简单到具体理解 Provider；
11. `runtime/audit.ts`：理解结果如何留痕。

阅读时可以持续跟踪一个问题：

> 当前这段代码是在“决定权限”，还是在“实施权限”，还是只是在“记录结果”？

## 12. 扩展原则

### 新增规则类型

优先放在 `policy/`，保持判定逻辑尽量纯净，不直接操作交互 UI、Provider 或审计文件。

### 新增 Provider

实现 `SandboxProvider` 接口并注册到 `providers/registry.ts`。Provider 应专注于：

- 可用性探测；
- 初始化；
- 命令包装；
- 错误输出标注；
- 违规事件读取。

不要把规则判断或用户审批塞进 Provider。

### 修改运行时行为

先确认改动属于哪一层：

- 启动装配：`bootstrap/`；
- 配置读取：`config/`；
- 调用判定：`policy/`；
- 审批、授权、边界协调和审计：`runtime/`；
- Bash 隔离实现：`providers/`。

避免让下层模块反向依赖上层模块，尤其避免 `policy → runtime`、`providers → runtime` 和 `config → runtime`。
