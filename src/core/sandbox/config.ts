import {
  readUserConfig,
  resolveUserConfigPath,
} from "../../shared/user-config";
import type { ApprovalPolicy, SandboxLevel } from "./types";

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

/** sandbox 段的规则子配置 */
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

/**
 * 判断值是否为字符串数组
 * @param {unknown} value - 待判断的值
 * @returns {boolean} 是字符串数组时为 true
 */
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * 解析字符串数组字段：非法时跳过并记录警告
 * @param {string} path - 字段的配置路径（警告文案用，如 filesystem、根级传空串）
 * @param {string} key - 字段名
 * @param {unknown} raw - 原始值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {string[] | undefined} 合法时返回数组，否则为 undefined
 */
function parseStringArray(
  path: string,
  key: string,
  raw: unknown,
  warnings: string[],
): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isStringArray(raw)) {
    const prefix = path ? `sandbox.${path}.` : "sandbox.";
    warnings.push(`${prefix}${key} 必须是字符串数组，已忽略该项`);
    return undefined;
  }
  return raw;
}

/**
 * 解析子对象字段：非对象时跳过并记录警告
 * @param {string} section - 段名
 * @param {unknown} raw - 原始值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {Record<string, unknown> | undefined} 合法时返回子对象，否则为 undefined
 */
function parseRecord(
  section: string,
  raw: unknown,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(`sandbox.${section} 必须是对象，已忽略该段`);
    return undefined;
  }
  return raw as Record<string, unknown>;
}

/**
 * 解析 sandbox.enabled（布尔）
 * @param {unknown} raw - 原始值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {boolean | undefined} 合法时返回布尔，否则为 undefined
 */
function parseEnabled(raw: unknown, warnings: string[]): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "boolean") {
    warnings.push("sandbox.enabled 必须是布尔值，已忽略该项");
    return undefined;
  }
  return raw;
}

/**
 * 解析 sandbox.level（枚举）
 * @param {unknown} raw - 原始值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {SandboxLevel | undefined} 合法时返回档位，否则为 undefined
 */
function parseLevel(
  raw: unknown,
  warnings: string[],
): SandboxLevel | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (
    typeof raw !== "string" ||
    !SANDBOX_LEVELS.includes(raw as SandboxLevel)
  ) {
    warnings.push(
      `sandbox.level 必须是 ${SANDBOX_LEVELS.join(" | ")} 之一，已忽略该项`,
    );
    return undefined;
  }
  return raw as SandboxLevel;
}

/**
 * 解析 sandbox.approval（枚举）
 * @param {unknown} raw - 原始值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {ApprovalPolicy | undefined} 合法时返回策略，否则为 undefined
 */
function parseApproval(
  raw: unknown,
  warnings: string[],
): ApprovalPolicy | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (
    typeof raw !== "string" ||
    !APPROVAL_POLICIES.includes(raw as ApprovalPolicy)
  ) {
    warnings.push(
      `sandbox.approval 必须是 ${APPROVAL_POLICIES.join(" | ")} 之一，已忽略该项`,
    );
    return undefined;
  }
  return raw as ApprovalPolicy;
}

/**
 * 解析 sandbox.timeoutMs（正整数，带下限钳制）
 * @param {unknown} raw - 原始值
 * @param {string} section - 子段名（警告文案用）
 * @param {number} minMs - 允许的最小值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {number | undefined} 合法时返回毫秒数，否则为 undefined
 */
function parseTimeoutMs(
  raw: unknown,
  section: string,
  minMs: number,
  warnings: string[],
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < minMs) {
    warnings.push(
      `sandbox.${section}.timeoutMs 必须是不小于 ${minMs} 的数字，已忽略该项`,
    );
    return undefined;
  }
  return Math.floor(raw);
}

/**
 * 加载 ~/.tx-cli/config.json 的 sandbox 段并逐项校验
 * 单个字段非法只跳过并记录警告，不影响其余字段与整个会话（失败隔离）
 * @param {string} configPath - 配置文件路径（缺省 ~/.tx-cli/config.json，测试可注入）
 * @returns {SandboxConfigResult} 解析后的配置与警告
 */
export function loadSandboxConfig(
  configPath: string = resolveUserConfigPath(),
): SandboxConfigResult {
  const warnings: string[] = [];
  const { data, warnings: readWarnings } = readUserConfig(configPath);
  warnings.push(...readWarnings);
  const raw = data.sandbox;
  if (raw === undefined) {
    return { config: DEFAULT_SANDBOX_CONFIG, warnings };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push("配置文件 sandbox 段必须是对象，已忽略整段沙箱配置");
    return { config: DEFAULT_SANDBOX_CONFIG, warnings };
  }
  const record = raw as Record<string, unknown>;
  // 深拷贝默认值的子对象：避免逐项赋值时污染模块级默认常量
  const config: SandboxFileConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    filesystem: { ...DEFAULT_SANDBOX_CONFIG.filesystem },
    network: { ...DEFAULT_SANDBOX_CONFIG.network },
    bash: { ...DEFAULT_SANDBOX_CONFIG.bash },
    rules: { ...DEFAULT_SANDBOX_CONFIG.rules },
  };

  const enabled = parseEnabled(record.enabled, warnings);
  if (enabled !== undefined) {
    config.enabled = enabled;
  }
  const level = parseLevel(record.level, warnings);
  if (level !== undefined) {
    config.level = level;
  }
  const approval = parseApproval(record.approval, warnings);
  if (approval !== undefined) {
    config.approval = approval;
  }
  if (typeof record.provider === "string" && record.provider.trim()) {
    config.provider = record.provider.trim();
  } else if (record.provider !== undefined) {
    warnings.push("sandbox.provider 必须是非空字符串，已忽略该项");
  }
  const trust = parseStringArray(
    "",
    "trustDirectories",
    record.trustDirectories,
    warnings,
  );
  if (trust !== undefined) {
    config.trustDirectories = trust;
  }
  if (record.builtinDangerRules !== undefined) {
    if (typeof record.builtinDangerRules === "boolean") {
      config.builtinDangerRules = record.builtinDangerRules;
    } else {
      warnings.push("sandbox.builtinDangerRules 必须是布尔值，已忽略该项");
    }
  }
  if (record.audit !== undefined) {
    if (typeof record.audit === "boolean") {
      config.audit = record.audit;
    } else {
      warnings.push("sandbox.audit 必须是布尔值，已忽略该项");
    }
  }

  const fs = parseRecord("filesystem", record.filesystem, warnings);
  if (fs) {
    const denyRead = parseStringArray(
      "filesystem",
      "denyRead",
      fs.denyRead,
      warnings,
    );
    if (denyRead !== undefined) {
      config.filesystem.denyRead = denyRead;
    }
    const denyWrite = parseStringArray(
      "filesystem",
      "denyWrite",
      fs.denyWrite,
      warnings,
    );
    if (denyWrite !== undefined) {
      config.filesystem.denyWrite = denyWrite;
    }
    const roots = parseStringArray(
      "filesystem",
      "writableRoots",
      fs.writableRoots,
      warnings,
    );
    if (roots !== undefined) {
      config.filesystem.writableRoots = roots;
    }
  }

  const net = parseRecord("network", record.network, warnings);
  if (net) {
    const domains = parseStringArray(
      "network",
      "allowedDomains",
      net.allowedDomains,
      warnings,
    );
    if (domains !== undefined) {
      config.network.allowedDomains = domains;
    }
  }

  const bash = parseRecord("bash", record.bash, warnings);
  if (bash) {
    if (bash.enabled !== undefined) {
      if (typeof bash.enabled === "boolean") {
        config.bash.enabled = bash.enabled;
      } else {
        warnings.push("sandbox.bash.enabled 必须是布尔值，已忽略该项");
      }
    }
    const timeoutMs = parseTimeoutMs(bash.timeoutMs, "bash", 1_000, warnings);
    if (timeoutMs !== undefined) {
      config.bash.timeoutMs = timeoutMs;
    }
  }

  const rules = parseRecord("rules", record.rules, warnings);
  if (rules) {
    const allow = parseStringArray("rules", "allow", rules.allow, warnings);
    if (allow !== undefined) {
      config.rules.allow = allow;
    }
    const ask = parseStringArray("rules", "ask", rules.ask, warnings);
    if (ask !== undefined) {
      config.rules.ask = ask;
    }
    const deny = parseStringArray("rules", "deny", rules.deny, warnings);
    if (deny !== undefined) {
      config.rules.deny = deny;
    }
  }

  return { config, warnings };
}
