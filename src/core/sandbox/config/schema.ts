import type { ApprovalPolicy, SandboxLevel } from "../types";

/** 全部合法沙箱档位（配置校验与提示用） */
export const SANDBOX_LEVELS: readonly SandboxLevel[] = [
  // 只读档位
  "read-only",
  // 可写入工作空间
  "workspace-write",
  // 允许所有操作
  "danger-full-access",
];

/** 全部合法审批策略（配置校验与提示用） */
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = [
  // 总是询问
  "always-ask",
  // 失败时询问
  "on-failure",
  // 从不询问
  "never",
];

/** sandbox 段的文件系统子配置 */
export interface SandboxFsConfig {
  /** 禁止读取的路径模式（在档位默认之上追加） */
  denyRead: string[];
  /** 在可写范围内仍禁止写入的路径模式（在档位默认之上追加） */
  denyWrite: string[];
  /** 追加的可写根目录（workspace-write 档生效） */
  writableRoots: string[];
}

/** sandbox 段的网络子配置 */
export interface SandboxNetworkConfig {
  /** 允许访问的域名（workspace-write 档生效，read-only 恒为空） */
  allowedDomains: string[];
}

/** sandbox 段的 bash 子配置 */
export interface SandboxBashConfig {
  /** 是否启用 bash 工具（--no-bash 可显式关闭） */
  enabled: boolean;
  /** 单命令执行超时（毫秒） */
  timeoutMs: number;
}

/** sandbox 段的规则子配置（bash 与内置工具规则；mcp__ 前缀的 MCP 规则兼容保留，新配置请写顶层 mcp.rules 段） */
export interface SandboxRulesConfig {
  /** 允许规则（命中直接放行） */
  allow: string[];
  /** 询问规则（命中进入审批） */
  ask: string[];
  /** 拒绝规则（命中直接拒绝） */
  deny: string[];
}

/** ~/.tx-cli/config.json 的 sandbox 段解析结果 */
export interface SandboxFileConfig {
  /** 沙箱总开关（false 时不装配 bash 工具） */
  enabled: boolean;
  /** 默认档位 */
  level: SandboxLevel;
  /** 默认审批策略 */
  approval: ApprovalPolicy;
  /** Provider 名称（注册表内查找） */
  provider: string;
  /** 信任目录：danger-full-access / never 仅在其中生效 */
  trustDirectories: string[];
  /** 是否启用内置危险命令类目（默认开） */
  builtinDangerRules: boolean;
  /** 文件系统扩展限制 */
  filesystem: SandboxFsConfig;
  /** 网络扩展限制 */
  network: SandboxNetworkConfig;
  /** bash 工具配置 */
  bash: SandboxBashConfig;
  /** 权限规则 */
  rules: SandboxRulesConfig;
  /** 是否写审计日志 */
  audit: boolean;
}

/** 单个配置文件 sandbox 段的部分解析结果：仅包含显式配置且合法的字段（两级文件合并用） */
export interface PartialSandboxFileConfig {
  /** 沙箱总开关 */
  enabled?: boolean;
  /** 档位 */
  level?: SandboxLevel;
  /** 审批策略 */
  approval?: ApprovalPolicy;
  /** Provider 名称 */
  provider?: string;
  /** 信任目录列表 */
  trustDirectories?: string[];
  /** 是否启用内置危险命令类目 */
  builtinDangerRules?: boolean;
  /** 文件系统扩展限制 */
  filesystem?: Partial<SandboxFsConfig>;
  /** 网络扩展限制 */
  network?: Partial<SandboxNetworkConfig>;
  /** bash 工具配置 */
  bash?: Partial<SandboxBashConfig>;
  /** 权限规则 */
  rules?: Partial<SandboxRulesConfig>;
  /** 是否写审计日志 */
  audit?: boolean;
}

/** 配置加载结果：解析后的配置与警告 */
export interface SandboxConfigResult {
  /** 解析后的沙箱配置（坏段跳过，余下照常生效） */
  config: SandboxFileConfig;
  /** 加载警告（文件损坏、坏项跳过原因等） */
  warnings: string[];
}

/** sandbox 段的默认值：未配置或整段缺失时使用 */
export const DEFAULT_SANDBOX_CONFIG: SandboxFileConfig = {
  enabled: true,
  level: "read-only",
  approval: "on-failure",
  provider: "srt",
  trustDirectories: [],
  builtinDangerRules: true,
  filesystem: { denyRead: [], denyWrite: [], writableRoots: [] },
  network: { allowedDomains: [] },
  bash: { enabled: true, timeoutMs: 120_000 },
  rules: { allow: [], ask: [], deny: [] },
  audit: true,
};
