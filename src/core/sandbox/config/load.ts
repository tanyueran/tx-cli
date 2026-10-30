import {
  readGlobalConfig,
  resolveGlobalConfigPath,
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
import { isStringArray } from "@/shared/string";

/**
 * 解析字符串数组字段：非法时跳过并记录警告
 * @param {string} sectionPath - 字段的配置路径（警告文案用，如 filesystem、根级传空串）
 * @param {string} key - 字段名
 * @param {unknown} rawValue - 原始值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {string[] | undefined} 合法时返回数组，否则为 undefined
 */
function parseStringArray(
  sectionPath: string,
  key: string,
  rawValue: unknown,
  warnings: string[],
): string[] | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (!isStringArray(rawValue)) {
    const prefix = sectionPath ? `sandbox.${sectionPath}.` : "sandbox.";
    warnings.push(`${prefix}${key} 必须是字符串数组，已忽略该项`);
    return undefined;
  }
  return rawValue;
}

/**
 * 解析子对象字段：非对象时跳过并记录警告
 * @param {string} section - 段名
 * @param {unknown} rawValue - 原始值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {Record<string, unknown> | undefined} 合法时返回子对象，否则为 undefined
 */
function parseRecord(
  section: string,
  rawValue: unknown,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (
    typeof rawValue !== "object" ||
    rawValue === null ||
    Array.isArray(rawValue)
  ) {
    warnings.push(`sandbox.${section} 必须是对象，已忽略该段`);
    return undefined;
  }
  return rawValue as Record<string, unknown>;
}

/**
 * 解析 sandbox.enabled（布尔）
 * @param {unknown} rawValue - 原始值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {boolean | undefined} 合法时返回布尔，否则为 undefined
 */
function parseEnabled(
  rawValue: unknown,
  warnings: string[],
): boolean | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (typeof rawValue !== "boolean") {
    warnings.push("sandbox.enabled 必须是布尔值，已忽略该项");
    return undefined;
  }
  return rawValue;
}

/**
 * 解析 sandbox.level（枚举）
 * @param {unknown} rawValue - 原始值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {SandboxLevel | undefined} 合法时返回档位，否则为 undefined
 */
function parseLevel(
  rawValue: unknown,
  warnings: string[],
): SandboxLevel | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (
    typeof rawValue !== "string" ||
    !SANDBOX_LEVELS.includes(rawValue as SandboxLevel)
  ) {
    warnings.push(
      `sandbox.level 必须是 ${SANDBOX_LEVELS.join(" | ")} 之一，已忽略该项`,
    );
    return undefined;
  }
  return rawValue as SandboxLevel;
}

/**
 * 解析 sandbox.approval（枚举）
 * @param {unknown} rawValue - 原始值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {ApprovalPolicy | undefined} 合法时返回策略，否则为 undefined
 */
function parseApproval(
  rawValue: unknown,
  warnings: string[],
): ApprovalPolicy | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (
    typeof rawValue !== "string" ||
    !APPROVAL_POLICIES.includes(rawValue as ApprovalPolicy)
  ) {
    warnings.push(
      `sandbox.approval 必须是 ${APPROVAL_POLICIES.join(" | ")} 之一，已忽略该项`,
    );
    return undefined;
  }
  return rawValue as ApprovalPolicy;
}

/**
 * 解析 sandbox.timeoutMs（正整数，带下限钳制）
 * @param {unknown} rawValue - 原始值
 * @param {string} section - 子段名（警告文案用）
 * @param {number} minMs - 允许的最小值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {number | undefined} 合法时返回毫秒数，否则为 undefined
 */
function parseTimeoutMs(
  rawValue: unknown,
  section: string,
  minMs: number,
  warnings: string[],
): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (
    typeof rawValue !== "number" ||
    !Number.isFinite(rawValue) ||
    rawValue < minMs
  ) {
    warnings.push(
      `sandbox.${section}.timeoutMs 必须是不小于 ${minMs} 的数字，已忽略该项`,
    );
    return undefined;
  }
  return Math.floor(rawValue);
}

/**
 * 解析单个配置文件的 sandbox 段为部分配置：仅收录显式配置且合法的字段，
 * 单个字段非法只跳过并记录警告，不影响其余字段（失败隔离）
 * @param {unknown} rawValue - 配置文件 sandbox 段原始值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {PartialSandboxFileConfig} 部分配置（段缺失时为空对象）
 */
function parseSandboxSection(
  rawValue: unknown,
  warnings: string[],
): PartialSandboxFileConfig {
  const partial: PartialSandboxFileConfig = {};
  if (rawValue === undefined) {
    return partial;
  }
  if (
    typeof rawValue !== "object" ||
    rawValue === null ||
    Array.isArray(rawValue)
  ) {
    warnings.push("配置文件 sandbox 段必须是对象，已忽略整段沙箱配置");
    return partial;
  }
  const record = rawValue as Record<string, unknown>;

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
  const trustDirectories = parseStringArray(
    "",
    "trustDirectories",
    record.trustDirectories,
    warnings,
  );
  if (trustDirectories !== undefined) {
    partial.trustDirectories = trustDirectories;
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

  const filesystemSection = parseRecord(
    "filesystem",
    record.filesystem,
    warnings,
  );
  if (filesystemSection) {
    const denyRead = parseStringArray(
      "filesystem",
      "denyRead",
      filesystemSection.denyRead,
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
      filesystemSection.denyWrite,
      warnings,
    );
    if (denyWrite !== undefined) {
      partial.filesystem = {
        ...partial.filesystem,
        denyWrite,
      };
    }
    const writableRoots = parseStringArray(
      "filesystem",
      "writableRoots",
      filesystemSection.writableRoots,
      warnings,
    );
    if (writableRoots !== undefined) {
      partial.filesystem = {
        ...partial.filesystem,
        writableRoots,
      };
    }
  }

  const networkSection = parseRecord("network", record.network, warnings);
  if (networkSection) {
    const allowedDomains = parseStringArray(
      "network",
      "allowedDomains",
      networkSection.allowedDomains,
      warnings,
    );
    if (allowedDomains !== undefined) {
      partial.network = { allowedDomains };
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
 * 归一化 MCP 规则：规则名可省略 mcp__ 前缀，统一补全（带前缀的写法原样保留）
 * @param {string} rule - 规则原文，如 Chrome_DevTools_MCP__* 或 mcp__github__*
 * @returns {string} 归一化后的规则（统一以 mcp__ 开头）
 */
function normalizeMcpRule(rule: string): string {
  const text = rule.trim();
  return text.startsWith("mcp__") ? text : `mcp__${text}`;
}

/**
 * 解析配置文件顶层 mcp 段的 rules 子段：MCP 工具专属的 allow/ask/deny 规则，
 * 与 sandbox.rules 分离存放，避免 MCP 规则混入沙箱配置造成误解（解析行为同 parseSandboxSection）
 * @param {unknown} rawValue - 配置文件 mcp 段原始值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {Partial<SandboxRulesConfig> | undefined} 归一化后的部分规则，段缺失时为 undefined
 */
function parseMcpRulesSection(
  rawValue: unknown,
  warnings: string[],
): Partial<SandboxRulesConfig> | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (
    typeof rawValue !== "object" ||
    rawValue === null ||
    Array.isArray(rawValue)
  ) {
    warnings.push("配置文件 mcp 段必须是对象，已忽略整段 MCP 规则");
    return undefined;
  }
  const rules = (rawValue as Record<string, unknown>).rules;
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
    const rawList = record[key];
    if (rawList === undefined) {
      continue;
    }
    if (!isStringArray(rawList)) {
      warnings.push(`mcp.rules.${key} 必须是字符串数组，已忽略该项`);
      continue;
    }
    partial[key] = rawList.map(normalizeMcpRule);
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
function applyToDefaults(partial: PartialSandboxFileConfig): SandboxFileConfig {
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

/** 沙箱档位的严格度：数值越小越严格（能力感知合并用） */
const LEVEL_STRICTNESS: Record<SandboxLevel, number> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
};

/** 审批策略的严格度：数值越小越严格（能力感知合并用） */
const APPROVAL_STRICTNESS: Record<ApprovalPolicy, number> = {
  "always-ask": 0,
  "on-failure": 1,
  never: 2,
};

/**
 * 生成「项目配置放宽项被忽略」的警告文案
 * @param {string} field - 配置字段路径（如 sandbox.level）
 * @param {string} detail - 忽略原因说明
 * @returns {string} 警告文案
 */
function looserIgnoredWarning(field: string, detail: string): string {
  return `已忽略项目配置的 ${field}：${detail}（项目配置仅可收紧沙箱能力，如需放宽请调整全局 ~/.tx-cli/config.json）`;
}

/**
 * 判断项目配置是否比全局配置更宽松（枚举严格度比较）
 * @param {number | undefined} projectStrictness - 项目配置的严格度（未配置时为 undefined）
 * @param {number} globalStrictness - 全局配置的严格度
 * @returns {boolean} 项目配置存在且更宽松时为 true
 */
function isLooser(
  projectStrictness: number | undefined,
  globalStrictness: number,
): boolean {
  return (
    projectStrictness !== undefined && projectStrictness > globalStrictness
  );
}

/**
 * 项目配置叠加到全局配置（能力感知合并）：项目配置仅可收紧沙箱能力、不可放宽——
 * 放宽类标量（关沙箱、放宽档位/审批、关内置危险规则、关审计、开 bash）与放宽类数组
 * （trustDirectories、writableRoots、allowedDomains）来自项目配置时忽略并记录警告，
 * 防止 clone 下来的仓库借自带 .tx-cli/config.json 自证信任、获得无审批执行权限；
 * rules.allow 保持并集合并：会话中「始终允许」授权经 appendProjectGrant 落盘项目配置，
 * 忽略会使既有授权失效；provider / bash.timeoutMs 为中性实现选项，项目覆盖全局
 * @param {SandboxFileConfig} globalConfig - 全局配置（已套用默认值）
 * @param {PartialSandboxFileConfig} projectConfig - 项目配置的部分解析结果
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {SandboxFileConfig} 合并后的生效配置
 */
function mergeProjectConfig(
  globalConfig: SandboxFileConfig,
  projectConfig: PartialSandboxFileConfig,
  warnings: string[],
): SandboxFileConfig {
  // 放宽类标量：项目配置更宽松时忽略并警告
  const enabled =
    projectConfig.enabled === false && globalConfig.enabled
      ? (warnings.push(
          looserIgnoredWarning("sandbox.enabled", "关闭沙箱比全局配置更宽松"),
        ),
        globalConfig.enabled)
      : (projectConfig.enabled ?? globalConfig.enabled);
  const level = isLooser(
    projectConfig.level === undefined
      ? undefined
      : LEVEL_STRICTNESS[projectConfig.level],
    LEVEL_STRICTNESS[globalConfig.level],
  )
    ? (warnings.push(
        looserIgnoredWarning(
          "sandbox.level",
          `"${projectConfig.level}" 比全局配置 "${globalConfig.level}" 更宽松`,
        ),
      ),
      globalConfig.level)
    : (projectConfig.level ?? globalConfig.level);
  const approval = isLooser(
    projectConfig.approval === undefined
      ? undefined
      : APPROVAL_STRICTNESS[projectConfig.approval],
    APPROVAL_STRICTNESS[globalConfig.approval],
  )
    ? (warnings.push(
        looserIgnoredWarning(
          "sandbox.approval",
          `"${projectConfig.approval}" 比全局配置 "${globalConfig.approval}" 更宽松`,
        ),
      ),
      globalConfig.approval)
    : (projectConfig.approval ?? globalConfig.approval);
  const builtinDangerRules =
    projectConfig.builtinDangerRules === false &&
    globalConfig.builtinDangerRules
      ? (warnings.push(
          looserIgnoredWarning(
            "sandbox.builtinDangerRules",
            "关闭内置危险命令类目比全局配置更宽松",
          ),
        ),
        globalConfig.builtinDangerRules)
      : (projectConfig.builtinDangerRules ?? globalConfig.builtinDangerRules);
  const audit =
    projectConfig.audit === false && globalConfig.audit
      ? (warnings.push(
          looserIgnoredWarning("sandbox.audit", "关闭审计日志比全局配置更宽松"),
        ),
        globalConfig.audit)
      : (projectConfig.audit ?? globalConfig.audit);
  const bashEnabled =
    projectConfig.bash?.enabled === true && !globalConfig.bash.enabled
      ? (warnings.push(
          looserIgnoredWarning(
            "sandbox.bash.enabled",
            "开启 bash 工具比全局配置更宽松",
          ),
        ),
        globalConfig.bash.enabled)
      : (projectConfig.bash?.enabled ?? globalConfig.bash.enabled);
  // 信任目录：仅可由全局配置提供，项目配置一律忽略（消灭自证信任入口）
  if (projectConfig.trustDirectories !== undefined) {
    warnings.push(
      "已忽略项目配置的 sandbox.trustDirectories：信任目录仅可由全局 ~/.tx-cli/config.json 提供，防止仓库自带配置自证信任",
    );
  }
  // 放宽类数组：扩大可写范围 / 网络白名单仅可由全局配置提供
  if (projectConfig.filesystem?.writableRoots !== undefined) {
    warnings.push(
      "已忽略项目配置的 sandbox.filesystem.writableRoots：扩大可写范围仅可由全局 ~/.tx-cli/config.json 提供",
    );
  }
  if (projectConfig.network?.allowedDomains !== undefined) {
    warnings.push(
      "已忽略项目配置的 sandbox.network.allowedDomains：扩大网络白名单仅可由全局 ~/.tx-cli/config.json 提供",
    );
  }
  return {
    enabled,
    level,
    approval,
    provider: projectConfig.provider ?? globalConfig.provider,
    trustDirectories: globalConfig.trustDirectories,
    builtinDangerRules,
    audit,
    filesystem: {
      // denyRead / denyWrite 为收紧类（追加禁读写边界），保持并集
      denyRead: projectConfig.filesystem?.denyRead
        ? mergeStringArrays(
            globalConfig.filesystem.denyRead,
            projectConfig.filesystem.denyRead,
          )
        : globalConfig.filesystem.denyRead,
      denyWrite: projectConfig.filesystem?.denyWrite
        ? mergeStringArrays(
            globalConfig.filesystem.denyWrite,
            projectConfig.filesystem.denyWrite,
          )
        : globalConfig.filesystem.denyWrite,
      writableRoots: globalConfig.filesystem.writableRoots,
    },
    network: {
      allowedDomains: globalConfig.network.allowedDomains,
    },
    bash: {
      enabled: bashEnabled,
      timeoutMs: projectConfig.bash?.timeoutMs ?? globalConfig.bash.timeoutMs,
    },
    rules: {
      // ask / deny 为收紧类，保持并集
      allow: projectConfig.rules?.allow
        ? mergeStringArrays(globalConfig.rules.allow, projectConfig.rules.allow)
        : globalConfig.rules.allow,
      ask: projectConfig.rules?.ask
        ? mergeStringArrays(globalConfig.rules.ask, projectConfig.rules.ask)
        : globalConfig.rules.ask,
      deny: projectConfig.rules?.deny
        ? mergeStringArrays(globalConfig.rules.deny, projectConfig.rules.deny)
        : globalConfig.rules.deny,
    },
  };
}

/** loadSandboxConfig 的入参 */
export interface LoadSandboxConfigOptions {
  /** 全局配置文件路径（缺省 ~/.tx-cli/config.json，测试可注入） */
  globalConfigPath?: string;
  /** 项目配置文件路径（缺省跳过项目层，生产由装配层传入，测试可注入） */
  projectConfigPath?: string;
}

/**
 * 加载 sandbox 与 mcp.rules 配置：全局 ~/.tx-cli/config.json 与项目 <cwd>/.tx-cli/config.json
 * 两级合并（项目配置仅可收紧沙箱能力，能力感知合并语义见 mergeProjectConfig），
 * 含 CLI 在内的完整优先级链路见 bootstrap/options.ts；
 * mcp.rules 段为 MCP 工具专属规则，与 sandbox.rules 同步解析并在文件内合并后参与两级合并；
 * 单个字段非法只跳过并记录警告，不影响其余字段与整个会话（失败隔离）
 * @param {LoadSandboxConfigOptions} [options] - 全局/项目配置文件路径（均可注入以便测试）
 * @returns {SandboxConfigResult} 解析后的配置与警告
 */
export function loadSandboxConfig({
  globalConfigPath = resolveGlobalConfigPath(),
  projectConfigPath,
}: LoadSandboxConfigOptions = {}): SandboxConfigResult {
  const warnings: string[] = [];
  const { configData, warnings: readWarnings } =
    readGlobalConfig(globalConfigPath);
  warnings.push(...readWarnings);
  const globalPartial = parseSandboxSection(configData.sandbox, warnings);
  mergeMcpRules(globalPartial, parseMcpRulesSection(configData.mcp, warnings));
  const config = applyToDefaults(globalPartial);
  if (projectConfigPath === undefined) {
    return { config, warnings };
  }
  const { configData: projectData, warnings: projectWarnings } =
    readGlobalConfig(projectConfigPath);
  warnings.push(...projectWarnings);
  const projectPartial = parseSandboxSection(projectData.sandbox, warnings);
  mergeMcpRules(
    projectPartial,
    parseMcpRulesSection(projectData.mcp, warnings),
  );
  if (projectData.sandbox !== undefined || projectData.mcp !== undefined) {
    warnings.push(
      `已加载项目配置 ${projectConfigPath} 的 sandbox 与 mcp 规则配置（项目配置仅可收紧沙箱能力，更宽松或涉及信任的配置项将被忽略）`,
    );
  }
  return {
    config: mergeProjectConfig(config, projectPartial, warnings),
    warnings,
  };
}
