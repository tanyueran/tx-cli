import {
  readUserConfig,
  resolveUserConfigPath,
} from "../../../shared/user-config";
import { mergeStringArrays } from "../../../shared/config-merge";
import type { ApprovalPolicy, SandboxLevel } from "../types";
import {
  APPROVAL_POLICIES,
  DEFAULT_SANDBOX_CONFIG,
  SANDBOX_LEVELS,
  type PartialSandboxFileConfig,
  type SandboxConfigResult,
  type SandboxFileConfig,
  type SandboxRulesConfig,
} from "./schema";

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
 * 解析单个配置文件的 sandbox 段为部分配置：仅收录显式配置且合法的字段，
 * 单个字段非法只跳过并记录警告，不影响其余字段（失败隔离）
 * @param {unknown} raw - 配置文件 sandbox 段原始值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {PartialSandboxFileConfig} 部分配置（段缺失时为空对象）
 */
function parseSandboxSection(
  raw: unknown,
  warnings: string[],
): PartialSandboxFileConfig {
  const partial: PartialSandboxFileConfig = {};
  if (raw === undefined) {
    return partial;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push("配置文件 sandbox 段必须是对象，已忽略整段沙箱配置");
    return partial;
  }
  const record = raw as Record<string, unknown>;

  const enabled = parseEnabled(record.enabled, warnings);
  if (enabled !== undefined) {
    partial.enabled = enabled;
  }
  const level = parseLevel(record.level, warnings);
  if (level !== undefined) {
    partial.level = level;
  }
  const approval = parseApproval(record.approval, warnings);
  if (approval !== undefined) {
    partial.approval = approval;
  }
  if (typeof record.provider === "string" && record.provider.trim()) {
    partial.provider = record.provider.trim();
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
    partial.trustDirectories = trust;
  }
  if (record.builtinDangerRules !== undefined) {
    if (typeof record.builtinDangerRules === "boolean") {
      partial.builtinDangerRules = record.builtinDangerRules;
    } else {
      warnings.push("sandbox.builtinDangerRules 必须是布尔值，已忽略该项");
    }
  }
  if (record.audit !== undefined) {
    if (typeof record.audit === "boolean") {
      partial.audit = record.audit;
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
      partial.filesystem = {
        ...partial.filesystem,
        denyRead,
      };
    }
    const denyWrite = parseStringArray(
      "filesystem",
      "denyWrite",
      fs.denyWrite,
      warnings,
    );
    if (denyWrite !== undefined) {
      partial.filesystem = {
        ...partial.filesystem,
        denyWrite,
      };
    }
    const roots = parseStringArray(
      "filesystem",
      "writableRoots",
      fs.writableRoots,
      warnings,
    );
    if (roots !== undefined) {
      partial.filesystem = {
        ...partial.filesystem,
        writableRoots: roots,
      };
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
      partial.network = { allowedDomains: domains };
    }
  }

  const bash = parseRecord("bash", record.bash, warnings);
  if (bash) {
    if (bash.enabled !== undefined) {
      if (typeof bash.enabled === "boolean") {
        partial.bash = { ...partial.bash, enabled: bash.enabled };
      } else {
        warnings.push("sandbox.bash.enabled 必须是布尔值，已忽略该项");
      }
    }
    const timeoutMs = parseTimeoutMs(bash.timeoutMs, "bash", 1_000, warnings);
    if (timeoutMs !== undefined) {
      partial.bash = { ...partial.bash, timeoutMs };
    }
  }

  const rules = parseRecord("rules", record.rules, warnings);
  if (rules) {
    const allow = parseStringArray("rules", "allow", rules.allow, warnings);
    if (allow !== undefined) {
      partial.rules = { ...partial.rules, allow };
    }
    const ask = parseStringArray("rules", "ask", rules.ask, warnings);
    if (ask !== undefined) {
      partial.rules = { ...partial.rules, ask };
    }
    const deny = parseStringArray("rules", "deny", rules.deny, warnings);
    if (deny !== undefined) {
      partial.rules = { ...partial.rules, deny };
    }
  }

  return partial;
}

/**
 * 归一化 MCP 规则：mcp.rules 段为 MCP 工具专属，规则名可省略 mcp__ 前缀，统一补全
 * （带前缀的写法原样保留，兼容从 sandbox.rules 迁移过来的规则文本）
 * @param {string} rule - 规则原文，如 Chrome_DevTools_MCP__* 或 mcp__github__*
 * @returns {string} 归一化后的规则（统一以 mcp__ 开头）
 */
function normalizeMcpRule(rule: string): string {
  const text = rule.trim();
  return text.startsWith("mcp__") ? text : `mcp__${text}`;
}

/**
 * 解析配置文件顶层 mcp 段的 rules 子段：MCP 工具专属的 allow/ask/deny 规则，
 * 与 sandbox.rules 分离存放，避免 MCP 规则混入沙箱配置造成误解；
 * 仅收录显式配置且合法的字段，单个字段非法只跳过并记录警告（失败隔离）
 * @param {unknown} raw - 配置文件 mcp 段原始值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {Partial<SandboxRulesConfig> | undefined} 归一化后的部分规则，段缺失时为 undefined
 */
function parseMcpRulesSection(
  raw: unknown,
  warnings: string[],
): Partial<SandboxRulesConfig> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push("配置文件 mcp 段必须是对象，已忽略整段 MCP 规则");
    return undefined;
  }
  const rules = (raw as Record<string, unknown>).rules;
  if (rules === undefined) {
    return undefined;
  }
  if (typeof rules !== "object" || rules === null || Array.isArray(rules)) {
    warnings.push("mcp.rules 必须是对象，已忽略该段");
    return undefined;
  }
  const record = rules as Record<string, unknown>;
  const partial: Partial<SandboxRulesConfig> = {};
  for (const key of ["allow", "ask", "deny"] as const) {
    const list = record[key];
    if (list === undefined) {
      continue;
    }
    if (!isStringArray(list)) {
      warnings.push(`mcp.rules.${key} 必须是字符串数组，已忽略该项`);
      continue;
    }
    partial[key] = list.map(normalizeMcpRule);
  }
  return partial;
}

/**
 * 把同文件的 mcp.rules 解析结果并入 sandbox.rules 部分配置：键内拼接去重，
 * 使 MCP 规则与 bash/内置工具规则在运行时共用同一组规则判定
 * @param {PartialSandboxFileConfig} partial - sandbox 段解析结果（就地修改）
 * @param {Partial<SandboxRulesConfig> | undefined} mcpRules - mcp.rules 解析结果
 * @returns {void}
 */
function mergeMcpRules(
  partial: PartialSandboxFileConfig,
  mcpRules: Partial<SandboxRulesConfig> | undefined,
): void {
  if (!mcpRules) {
    return;
  }
  const rules: Partial<SandboxRulesConfig> = { ...partial.rules };
  if (mcpRules.allow !== undefined) {
    rules.allow = mergeStringArrays(rules.allow ?? [], mcpRules.allow);
  }
  if (mcpRules.ask !== undefined) {
    rules.ask = mergeStringArrays(rules.ask ?? [], mcpRules.ask);
  }
  if (mcpRules.deny !== undefined) {
    rules.deny = mergeStringArrays(rules.deny ?? [], mcpRules.deny);
  }
  partial.rules = rules;
}

/**
 * 将部分配置套用到默认配置：单个文件内数组字段整段替换（维持既有语义）
 * @param {PartialSandboxFileConfig} partial - 解析出的部分配置
 * @returns {SandboxFileConfig} 完整配置（未配置字段取内置默认）
 */
function applyToDefaults(
  partial: PartialSandboxFileConfig,
): SandboxFileConfig {
  const config: SandboxFileConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    filesystem: { ...DEFAULT_SANDBOX_CONFIG.filesystem },
    network: { ...DEFAULT_SANDBOX_CONFIG.network },
    bash: { ...DEFAULT_SANDBOX_CONFIG.bash },
    rules: { ...DEFAULT_SANDBOX_CONFIG.rules },
  };
  if (partial.enabled !== undefined) {
    config.enabled = partial.enabled;
  }
  if (partial.level !== undefined) {
    config.level = partial.level;
  }
  if (partial.approval !== undefined) {
    config.approval = partial.approval;
  }
  if (partial.provider !== undefined) {
    config.provider = partial.provider;
  }
  if (partial.trustDirectories !== undefined) {
    config.trustDirectories = partial.trustDirectories;
  }
  if (partial.builtinDangerRules !== undefined) {
    config.builtinDangerRules = partial.builtinDangerRules;
  }
  if (partial.audit !== undefined) {
    config.audit = partial.audit;
  }
  if (partial.filesystem?.denyRead !== undefined) {
    config.filesystem.denyRead = partial.filesystem.denyRead;
  }
  if (partial.filesystem?.denyWrite !== undefined) {
    config.filesystem.denyWrite = partial.filesystem.denyWrite;
  }
  if (partial.filesystem?.writableRoots !== undefined) {
    config.filesystem.writableRoots = partial.filesystem.writableRoots;
  }
  if (partial.network?.allowedDomains !== undefined) {
    config.network.allowedDomains = partial.network.allowedDomains;
  }
  if (partial.bash?.enabled !== undefined) {
    config.bash.enabled = partial.bash.enabled;
  }
  if (partial.bash?.timeoutMs !== undefined) {
    config.bash.timeoutMs = partial.bash.timeoutMs;
  }
  if (partial.rules?.allow !== undefined) {
    config.rules.allow = partial.rules.allow;
  }
  if (partial.rules?.ask !== undefined) {
    config.rules.ask = partial.rules.ask;
  }
  if (partial.rules?.deny !== undefined) {
    config.rules.deny = partial.rules.deny;
  }
  return config;
}

/**
 * 项目配置叠加到全局配置：标量字段项目覆盖全局，数组字段并集去重（全局在前、项目在后）
 * @param {SandboxFileConfig} global - 全局配置（已套用默认值）
 * @param {PartialSandboxFileConfig} project - 项目配置的部分解析结果
 * @returns {SandboxFileConfig} 合并后的生效配置
 */
function mergeProjectConfig(
  global: SandboxFileConfig,
  project: PartialSandboxFileConfig,
): SandboxFileConfig {
  return {
    enabled: project.enabled ?? global.enabled,
    level: project.level ?? global.level,
    approval: project.approval ?? global.approval,
    provider: project.provider ?? global.provider,
    trustDirectories: project.trustDirectories
      ? mergeStringArrays(global.trustDirectories, project.trustDirectories)
      : global.trustDirectories,
    builtinDangerRules: project.builtinDangerRules ?? global.builtinDangerRules,
    audit: project.audit ?? global.audit,
    filesystem: {
      denyRead: project.filesystem?.denyRead
        ? mergeStringArrays(global.filesystem.denyRead, project.filesystem.denyRead)
        : global.filesystem.denyRead,
      denyWrite: project.filesystem?.denyWrite
        ? mergeStringArrays(global.filesystem.denyWrite, project.filesystem.denyWrite)
        : global.filesystem.denyWrite,
      writableRoots: project.filesystem?.writableRoots
        ? mergeStringArrays(global.filesystem.writableRoots, project.filesystem.writableRoots)
        : global.filesystem.writableRoots,
    },
    network: {
      allowedDomains: project.network?.allowedDomains
        ? mergeStringArrays(global.network.allowedDomains, project.network.allowedDomains)
        : global.network.allowedDomains,
    },
    bash: {
      enabled: project.bash?.enabled ?? global.bash.enabled,
      timeoutMs: project.bash?.timeoutMs ?? global.bash.timeoutMs,
    },
    rules: {
      allow: project.rules?.allow
        ? mergeStringArrays(global.rules.allow, project.rules.allow)
        : global.rules.allow,
      ask: project.rules?.ask
        ? mergeStringArrays(global.rules.ask, project.rules.ask)
        : global.rules.ask,
      deny: project.rules?.deny
        ? mergeStringArrays(global.rules.deny, project.rules.deny)
        : global.rules.deny,
    },
  };
}

/**
 * 加载 sandbox 与 mcp.rules 配置：全局 ~/.tx-cli/config.json 与项目 <cwd>/.tx-cli/config.json 两级合并，
 * 优先级为 CLI（命令层处理）> 项目配置 > 全局配置 > 内置默认；
 * 标量字段项目覆盖全局，数组字段（trustDirectories、filesystem、network、rules）并集合并；
 * mcp.rules 段为 MCP 工具专属规则，与 sandbox.rules 同步解析并在文件内合并后参与两级合并；
 * 单个字段非法只跳过并记录警告，不影响其余字段与整个会话（失败隔离）
 * @param {string} configPath - 全局配置文件路径（缺省 ~/.tx-cli/config.json，测试可注入）
 * @param {string} projectPath - 项目配置文件路径（缺省跳过项目层，生产由装配层传入，测试可注入）
 * @returns {SandboxConfigResult} 解析后的配置与警告
 */
export function loadSandboxConfig(
  configPath: string = resolveUserConfigPath(),
  projectPath?: string,
): SandboxConfigResult {
  const warnings: string[] = [];
  const { data, warnings: readWarnings } = readUserConfig(configPath);
  warnings.push(...readWarnings);
  const globalPartial = parseSandboxSection(data.sandbox, warnings);
  mergeMcpRules(globalPartial, parseMcpRulesSection(data.mcp, warnings));
  const config = applyToDefaults(globalPartial);
  if (projectPath === undefined) {
    return { config, warnings };
  }
  const { data: projectData, warnings: projectWarnings } =
    readUserConfig(projectPath);
  warnings.push(...projectWarnings);
  const projectPartial = parseSandboxSection(projectData.sandbox, warnings);
  mergeMcpRules(projectPartial, parseMcpRulesSection(projectData.mcp, warnings));
  if (projectData.sandbox !== undefined || projectData.mcp !== undefined) {
    warnings.push(
      `已加载项目配置 ${projectPath} 的 sandbox 与 mcp 规则配置（标量以项目为准，数组与全局配置合并）`,
    );
  }
  return { config: mergeProjectConfig(config, projectPartial), warnings };
}
