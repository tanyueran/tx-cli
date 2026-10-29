import type {
  ApprovalPolicy,
  RuleDecision,
  SandboxLevel,
} from "../types";
import type { SandboxRulesConfig } from "../config/schema";
import { matchDangerRule, type DangerRule } from "./danger";
import { matchSpec, parseRule, type ParsedRule } from "./syntax";
import {
  normalizeCommand,
  splitTopLevel,
  stripWrappers,
} from "../utils/command";
import { compileGlob } from "../utils/glob";

/** 规则判定结果：判定 + 命中来源 + 中文说明 */
export interface RuleEvaluation {
  /** 最终判定 */
  decision: RuleDecision;
  /** 命中的规则原文或类目名（档位默认时为空串） */
  matchedRule: string;
  /** 中文说明（回传模型与提示用户） */
  reason: string;
}

/**
 * 用一组同工具名的规则匹配单个命令段
 * @param {ParsedRule[]} rules - 已解析的规则（假定与目标工具同名）
 * @param {string} segment - 原始命令段（已折叠空白）
 * @param {boolean} shouldMatchUnwrapped - 是否额外用剥离包装形态匹配
 * @returns {ParsedRule | undefined} 命中的第一条规则
 */
function matchSegment(
  rules: ParsedRule[],
  segment: string,
  shouldMatchUnwrapped: boolean,
): ParsedRule | undefined {
  const candidates = shouldMatchUnwrapped
    ? [segment, stripWrappers(segment)]
    : [segment];
  for (const rule of rules) {
    if (rule.pattern === undefined) {
      // 整工具规则：段非空即命中
      if (candidates.some((candidate) => candidate.length > 0)) {
        return rule;
      }
      continue;
    }
    for (const candidate of candidates) {
      if (matchSpec(rule.pattern, candidate)) {
        return rule;
      }
    }
  }
  return undefined;
}

/** 规则判定的工具类目：影响未命中规则时的默认判定 */
export type ToolCategory = "command" | "tool" | "mcp-tool" | "mcp-read";

/**
 * 按档位、审批策略与工具类目给出未命中任何规则时的默认判定
 * - danger-full-access：沙箱与规则全关，默认放行
 * - mcp-read：MCP 只读工具（readOnlyHint 为 true）无外部副作用，默认放行；
 *   always-ask 策略下仍征询，尊重用户"每次都问"的显式选择
 * - mcp-tool：MCP 工具在沙箱硬边界之外，不走"沙箱兜底放行"，默认改为审批；
 *   never 策略无法征询，按拒绝处理（fail-closed）
 * - tool 且声明 net 能力（read-only 档）：read-only 承诺禁网，而进程内网络工具
 *   不受沙箱网络白名单约束；声明 readOnlySafe 的无副作用只读检索工具（如 web_search）
 *   口径对齐 mcp-read 默认放行（always-ask 策略下仍征询），
 *   其余未命中规则时默认审批（与 MCP 工具口径对齐）；never 策略无法征询，按拒绝处理
 * - 其余类目：read-only/workspace-write 依赖沙箱硬边界兜底默认放行；
 *   always-ask 策略下未知命令交由用户裁决
 * @param {SandboxLevel} level - 沙箱档位
 * @param {ApprovalPolicy} approval - 审批策略
 * @param {ToolCategory} category - 工具类目（bash 为 command，内置工具为 tool，MCP 工具为 mcp-tool / mcp-read）
 * @param {string} ruleKey - 规则键（默认审批时用作授权粒度，其余类目忽略）
 * @param {readonly string[]} capabilities - 工具能力声明（net 等空格分隔键）
 * @param {boolean} readOnlySafe - 是否为无副作用只读检索工具（read-only 档 net 判定用）
 * @returns {RuleEvaluation} 默认判定
 */
function defaultDecision(
  level: SandboxLevel,
  approval: ApprovalPolicy,
  category: ToolCategory,
  ruleKey = "",
  capabilities: readonly string[] = [],
  readOnlySafe = false,
): RuleEvaluation {
  if (level === "danger-full-access") {
    return {
      decision: "allow",
      matchedRule: "",
      reason: "danger-full-access 档位默认放行",
    };
  }
  if (category === "mcp-read") {
    if (approval === "always-ask") {
      return {
        decision: "ask",
        // matchedRule 取工具键本身：用户选"本会话/始终允许"时按该工具粒度复用授权
        matchedRule: ruleKey,
        reason: `只读 MCP 工具 ${ruleKey} 未命中任何规则，always-ask 策略下默认询问`,
      };
    }
    return {
      decision: "allow",
      matchedRule: "",
      reason: `只读 MCP 工具 ${ruleKey} 已声明 readOnlyHint，默认放行`,
    };
  }
  if (category === "mcp-tool") {
    if (approval === "never") {
      return {
        decision: "deny",
        matchedRule: "",
        reason: `MCP 工具 ${ruleKey} 默认需要审批，never 策略无法征询已拒绝（可配置 allow 规则放行）`,
      };
    }
    return {
      decision: "ask",
      // matchedRule 取工具键本身：用户选"本会话/始终允许"时按该工具粒度复用授权
      matchedRule: ruleKey,
      reason: `MCP 工具 ${ruleKey} 未命中任何规则，默认需要审批`,
    };
  }
  if (level === "read-only" && category === "tool" && capabilities.includes("net")) {
    // 只读检索工具无外部副作用，口径对齐声明 readOnlyHint 的 MCP 只读工具：默认放行，always-ask 仍询问
    if (readOnlySafe) {
      if (approval === "always-ask") {
        return {
          decision: "ask",
          // matchedRule 取规则键本身：用户选"本会话/始终允许"时按该工具粒度复用授权
          matchedRule: ruleKey,
          reason: `只读检索工具 ${ruleKey} 未命中任何规则，always-ask 策略下默认询问`,
        };
      }
      return {
        decision: "allow",
        matchedRule: "",
        reason: `只读检索工具 ${ruleKey} 已声明无副作用，默认放行`,
      };
    }
    if (approval === "never") {
      return {
        decision: "deny",
        matchedRule: "",
        reason: `网络工具 ${ruleKey} 在 read-only 档默认需要审批，never 策略无法征询已拒绝（可配置 allow 规则放行）`,
      };
    }
    return {
      decision: "ask",
      // matchedRule 取规则键本身：用户选"本会话/始终允许"时按该工具粒度复用授权
      matchedRule: ruleKey,
      reason: `网络工具 ${ruleKey} 在 read-only 档默认需要审批（该档承诺禁网，进程内网络调用不受沙箱边界约束）`,
    };
  }
  if (approval === "always-ask") {
    return {
      decision: "ask",
      matchedRule: "",
      reason: "命令未命中任何规则，always-ask 策略下默认询问",
    };
  }
  return {
    decision: "allow",
    matchedRule: "",
    reason: `命令未命中任何规则，${level} 档由沙箱硬边界兜底`,
  };
}

/**
 * L2 规则判定：对 bash 命令做复合切分 + 包装穿透 + 优先级短路
 * 优先级：deny（含内置危险类目）> ask > allow > 档位默认；
 * 复合命令逐段判定：任一段 deny 则整条 deny，否则任一段 ask 则整条 ask，
 * 全部段 allow 才视为命中 allow
 * @param {string} command - 原始 bash 命令
 * @param {SandboxRulesConfig} rules - 用户规则（allow/ask/deny）
 * @param {readonly DangerRule[] | null} dangerRules - 内置危险类目（null 表示整体关闭）
 * @param {SandboxLevel} level - 沙箱档位
 * @param {ApprovalPolicy} approval - 审批策略
 * @returns {RuleEvaluation} 判定结果
 */
export function evaluateCommand(
  command: string,
  rules: SandboxRulesConfig,
  dangerRules: readonly DangerRule[] | null,
  level: SandboxLevel,
  approval: ApprovalPolicy,
): RuleEvaluation {
  const denyRules = rules.deny
    .map(parseRule)
    .filter(
      (parsed): parsed is ParsedRule =>
        parsed !== undefined && parsed.toolName === "bash",
    );
  const askRules = rules.ask
    .map(parseRule)
    .filter(
      (parsed): parsed is ParsedRule =>
        parsed !== undefined && parsed.toolName === "bash",
    );
  const allowRules = rules.allow
    .map(parseRule)
    .filter(
      (parsed): parsed is ParsedRule =>
        parsed !== undefined && parsed.toolName === "bash",
    );

  const segments = splitTopLevel(command).map(normalizeCommand);
  if (segments.length === 0) {
    return {
      decision: "deny",
      matchedRule: "",
      reason: "命令为空",
    };
  }

  let hasAskHit = false;
  let hasUnmatchedSegment = false;
  let askMatched = "";
  for (const segment of segments) {
    // 内置危险类目与用户 deny 均走穿透匹配（allow 不穿透）
    const dangerHit = dangerRules
      ? matchDangerRule(stripWrappers(segment), dangerRules)
      : undefined;
    if (dangerHit) {
      return {
        decision: "deny",
        matchedRule: dangerHit.name,
        reason: `命令命中内置危险类目「${dangerHit.reason}」`,
      };
    }
    const deniedRule = matchSegment(denyRules, segment, true);
    if (deniedRule) {
      return {
        decision: "deny",
        matchedRule: deniedRule.rawText,
        reason: `命令命中拒绝规则 ${deniedRule.rawText}`,
      };
    }
    const askedRule = matchSegment(askRules, segment, true);
    if (askedRule) {
      hasAskHit = true;
      // 记录首条命中的询问规则：会话/始终授权按此规则粒度复用
      if (!askMatched) {
        askMatched = askedRule.rawText;
      }
      continue;
    }
    const allowedRule = matchSegment(allowRules, segment, false);
    if (!allowedRule) {
      hasUnmatchedSegment = true;
    }
  }

  if (hasAskHit) {
    return {
      decision: "ask",
      matchedRule: askMatched,
      reason: `命令段命中询问规则 ${askMatched}，需要用户审批`,
    };
  }
  if (hasUnmatchedSegment) {
    return defaultDecision(level, approval, "command");
  }
  return {
    decision: "allow",
    matchedRule: "",
    reason: "命令所有段均命中允许规则",
  };
}

/**
 * 判断规则名与目标规则键名是否匹配
 * 精确相等，或双方均为 mcp__ 前缀且规则名含 * 时按 glob 匹配
 * （MCP 工具数量多，支持 mcp__server__* 这类通配整组放行/审批/拒绝）
 * @param {string} ruleName - 已解析的规则名
 * @param {string} keyName - 目标规则键名
 * @returns {boolean} 匹配时为 true
 */
function nameMatches(ruleName: string, keyName: string): boolean {
  if (ruleName === keyName) {
    return true;
  }
  return (
    ruleName.includes("*") &&
    ruleName.startsWith("mcp__") &&
    keyName.startsWith("mcp__") &&
    compileGlob(ruleName).test(keyName)
  );
}

/**
 * L2 规则判定：对非 bash 工具的规则键匹配
 * 规则键形如 read(/abs/path/to/file)、web_search、mcp__server__tool
 * 优先级：deny > ask > allow > 类目默认；MCP 工具默认审批，其余内置工具默认放行走沙箱
 * @param {string} ruleKey - 工具生成的规则键
 * @param {SandboxRulesConfig} rules - 用户规则
 * @param {SandboxLevel} level - 沙箱档位
 * @param {ApprovalPolicy} approval - 审批策略
 * @param {ToolCategory} category - 工具类目（默认内置工具 tool）
 * @param {readonly string[]} capabilities - 工具能力声明（read-only 档 net 能力默认审批用）
 * @param {boolean} readOnlySafe - 是否为无副作用只读检索工具（read-only 档 net 判定用）
 * @returns {RuleEvaluation} 判定结果
 */
export function evaluateRuleKey(
  ruleKey: string,
  rules: SandboxRulesConfig,
  level: SandboxLevel,
  approval: ApprovalPolicy,
  category: ToolCategory = "tool",
  capabilities: readonly string[] = [],
  readOnlySafe = false,
): RuleEvaluation {
  const parsedKey = parseRule(ruleKey);
  if (!parsedKey) {
    return {
      decision: "deny",
      matchedRule: "",
      reason: `规则键非法：${ruleKey}`,
    };
  }
  const sameName = (
    ruleTexts: string[],
    decision: RuleDecision,
  ): RuleEvaluation | undefined => {
    for (const ruleText of ruleTexts) {
      const rule = parseRule(ruleText);
      if (!rule || !nameMatches(rule.toolName, parsedKey.toolName)) {
        continue;
      }
      const isMatch =
        rule.pattern === undefined ||
        (parsedKey.pattern !== undefined &&
          matchSpec(rule.pattern, parsedKey.pattern));
      if (isMatch) {
        return {
          decision,
          matchedRule: rule.rawText,
          reason: `命中${decision === "deny" ? "拒绝" : decision === "ask" ? "询问" : "允许"}规则 ${rule.rawText}`,
        };
      }
    }
    return undefined;
  };

  const deniedResult = sameName(rules.deny, "deny");
  if (deniedResult) {
    return deniedResult;
  }
  const askedResult = sameName(rules.ask, "ask");
  if (askedResult) {
    return askedResult;
  }
  const allowedResult = sameName(rules.allow, "allow");
  if (allowedResult) {
    return allowedResult;
  }
  return defaultDecision(
    level,
    approval,
    category,
    ruleKey,
    capabilities,
    readOnlySafe,
  );
}
