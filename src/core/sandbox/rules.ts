import { matchDangerRule, type DangerRule } from "./danger-rules";
import type {
  ApprovalPolicy,
  RuleDecision,
  SandboxLevel,
} from "./types";
import type { SandboxRulesConfig } from "./config";

/**
 * 规则名归一化映射：用户习惯的短名（Claude Code 风格）→ 内部工具名
 * 规则键（工具侧）与规则（用户侧）都经 parseRule 归一化后匹配，
 * 使 Read(/src/**) 与 read_file(/src/a) 能互相命中
 */
const RULE_NAME_ALIASES: ReadonlyMap<string, string> = new Map([
  ["read", "read_file"],
  ["websearch", "web_search"],
  ["listdir", "list_dir"],
]);

/**
 * 归一化规则名：别名映射到内部工具名，其余原样返回（已小写）
 * @param {string} name - 解析出的规则名（小写）
 * @returns {string} 归一化后的规则名
 */
function normalizeRuleName(name: string): string {
  return RULE_NAME_ALIASES.get(name) ?? name;
}

/** 单条规则的解析结果：工具名 + 可选细粒度模式 */
export interface ParsedRule {
  /** 工具名（小写化，匹配不区分大小写），如 bash、read_file、web_search */
  name: string;
  /** 括号内的细粒度模式；整工具规则（如 WebSearch）无此字段 */
  spec?: string;
  /** 规则原文（审计与提示用） */
  raw: string;
}

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
 * 解析单条规则文本：Name(spec) 细粒度 或 Name 整工具
 * 规则名做别名归一化（Read→read_file 等），使短名规则与内部工具键互相命中；
 * 非法格式返回 undefined，由调用方决定跳过策略
 * @param {string} raw - 规则原文，如 `Bash(git push:*)`、`Read(/src/**)`、`WebSearch`
 * @returns {ParsedRule | undefined} 解析结果，非法时为 undefined
 */
export function parseRule(raw: string): ParsedRule | undefined {
  const text = raw.trim();
  if (!text) {
    return undefined;
  }
  const open = text.indexOf("(");
  if (open === -1) {
    return { name: normalizeRuleName(text.toLowerCase()), raw: text };
  }
  if (!text.endsWith(")")) {
    return undefined;
  }
  const name = normalizeRuleName(text.slice(0, open).trim().toLowerCase());
  const spec = text.slice(open + 1, -1).trim();
  if (!name || !spec) {
    return undefined;
  }
  return { name, spec, raw: text };
}

/**
 * 把 glob 风格模式编译为正则：* 匹配任意字符序列，其余按字面量转义
 * @param {string} pattern - 含通配符的模式
 * @returns {RegExp} 锚定首尾的正则
 */
function compileGlob(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * 匹配细粒度模式与目标文本
 * 三种语法：`cmd` 精确、`prefix:*` 前缀、含 `*` 的 glob
 * @param {string} spec - 模式（如 git push:*、git status、git log *、/src/**）
 * @param {string} subject - 目标文本（命令段或路径）
 * @returns {boolean} 匹配时为 true
 */
export function matchSpec(spec: string, subject: string): boolean {
  if (spec.endsWith(":*")) {
    const prefix = spec.slice(0, -2).trimEnd();
    return prefix.length > 0 && subject.startsWith(prefix);
  }
  if (spec.includes("*")) {
    return compileGlob(spec).test(subject);
  }
  return spec === subject;
}

/**
 * 切分复合命令的顶层段：按 &&、||、;、| 切分，引号内的分隔符不切
 * 只处理一层结构，不展开子 shell（(...) 与 {...} 内的分隔符不切，保持简化）
 * @param {string} command - 原始命令文本
 * @returns {string[]} 非空的顶层段列表（保持原顺序）
 */
export function splitTopLevel(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "&" || ch === ";" || ch === "|") {
      // && 与 || 消耗两个字符，单 & 也按分隔处理（简化：少见且宽松切分更安全）
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 无参数执行的包装前缀命令（穿透剥离用） */
const WRAPPER_PREFIXES = new Set(["env", "nohup", "xargs"]);

/**
 * 剥离命令段的常见包装前缀，还原真实命令
 * 处理 FOO=bar 环境变量赋值前缀、env/nohup 包装与 xargs 透传，
 * 用于 deny/ask 规则匹配（allow 不穿透，必须匹配完整原文）
 * @param {string} segment - 原始命令段
 * @returns {string} 剥离包装后的命令段（无可剥离时与原文一致）
 */
export function stripWrappers(segment: string): string {
  let text = segment.trim();
  // 循环剥离：VAR=value 与 env/nohup 前缀可交替出现多层
  for (;;) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(\S*)\s+/.exec(text);
    if (assignment) {
      text = text.slice(assignment[0].length);
      continue;
    }
    const first = text.split(/\s+/)[0] ?? "";
    if (WRAPPER_PREFIXES.has(first)) {
      // xargs 后可能带自身选项（如 -I{} -n1），仅剥离 xargs 到下一个非选项参数过于复杂，
      // 简化为剥离 xargs token 本身，让后续真实命令暴露给规则匹配
      text = text.slice(first.length).trim();
      continue;
    }
    return text;
  }
}

/**
 * 折叠命令文本中的连续空白为单个空格
 * 避免多个空格绕过精确匹配（如 "git  status"）
 * @param {string} text - 原始文本
 * @returns {string} 折叠后的文本
 */
export function normalizeCommand(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * 用一组同工具名的规则匹配单个命令段
 * @param {ParsedRule[]} rules - 已解析的规则（假定与目标工具同名）
 * @param {string} segment - 原始命令段（已折叠空白）
 * @param {boolean} unwrapped - 是否额外用剥离包装形态匹配
 * @returns {ParsedRule | undefined} 命中的第一条规则
 */
function matchSegment(
  rules: ParsedRule[],
  segment: string,
  unwrapped: boolean,
): ParsedRule | undefined {
  const candidates = unwrapped ? [segment, stripWrappers(segment)] : [segment];
  for (const rule of rules) {
    if (rule.spec === undefined) {
      // 整工具规则：段非空即命中
      if (candidates.some((c) => c.length > 0)) {
        return rule;
      }
      continue;
    }
    for (const candidate of candidates) {
      if (matchSpec(rule.spec, candidate)) {
        return rule;
      }
    }
  }
  return undefined;
}

/** 规则判定的工具类目：影响未命中规则时的默认判定 */
export type ToolCategory = "command" | "tool" | "mcp-tool";

/**
 * 按档位、审批策略与工具类目给出未命中任何规则时的默认判定
 * - danger-full-access：沙箱与规则全关，默认放行
 * - mcp-tool：MCP 工具在沙箱硬边界之外，不走"沙箱兜底放行"，默认改为审批；
 *   never 策略无法征询，按拒绝处理（fail-closed）
 * - 其余类目：read-only/workspace-write 依赖沙箱硬边界兜底默认放行；
 *   always-ask 策略下未知命令交由用户裁决
 * @param {SandboxLevel} level - 沙箱档位
 * @param {ApprovalPolicy} approval - 审批策略
 * @param {ToolCategory} category - 工具类目（bash 为 command，内置工具为 tool，MCP 工具为 mcp-tool）
 * @param {string} ruleKey - 规则键（mcp-tool 默认审批时用作授权粒度，其余类目忽略）
 * @returns {RuleEvaluation} 默认判定
 */
function defaultDecision(
  level: SandboxLevel,
  approval: ApprovalPolicy,
  category: ToolCategory,
  ruleKey = "",
): RuleEvaluation {
  if (level === "danger-full-access") {
    return {
      decision: "allow",
      matchedRule: "",
      reason: "danger-full-access 档位默认放行",
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
    .filter((r): r is ParsedRule => r !== undefined && r.name === "bash");
  const askRules = rules.ask
    .map(parseRule)
    .filter((r): r is ParsedRule => r !== undefined && r.name === "bash");
  const allowRules = rules.allow
    .map(parseRule)
    .filter((r): r is ParsedRule => r !== undefined && r.name === "bash");

  const segments = splitTopLevel(command).map(normalizeCommand);
  if (segments.length === 0) {
    return {
      decision: "deny",
      matchedRule: "",
      reason: "命令为空",
    };
  }

  let sawAsk = false;
  let sawDefault = false;
  let askMatched = "";
  for (const segment of segments) {
    // 内置危险类目与用户 deny 均走穿透匹配（allow 不穿透）
    const danger = dangerRules
      ? matchDangerRule(stripWrappers(segment), dangerRules)
      : undefined;
    if (danger) {
      return {
        decision: "deny",
        matchedRule: danger.name,
        reason: `命令命中内置危险类目「${danger.reason}」`,
      };
    }
    const denied = matchSegment(denyRules, segment, true);
    if (denied) {
      return {
        decision: "deny",
        matchedRule: denied.raw,
        reason: `命令命中拒绝规则 ${denied.raw}`,
      };
    }
    const asked = matchSegment(askRules, segment, true);
    if (asked) {
      sawAsk = true;
      // 记录首条命中的询问规则：会话/始终授权按此规则粒度复用
      if (!askMatched) {
        askMatched = asked.raw;
      }
      continue;
    }
    const allowed = matchSegment(allowRules, segment, false);
    if (!allowed) {
      sawDefault = true;
    }
  }

  if (sawAsk) {
    return {
      decision: "ask",
      matchedRule: askMatched,
      reason: `命令段命中询问规则 ${askMatched}，需要用户审批`,
    };
  }
  if (sawDefault) {
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
 * @returns {RuleEvaluation} 判定结果
 */
export function evaluateRuleKey(
  ruleKey: string,
  rules: SandboxRulesConfig,
  level: SandboxLevel,
  approval: ApprovalPolicy,
  category: ToolCategory = "tool",
): RuleEvaluation {
  const parsedKey = parseRule(ruleKey);
  if (!parsedKey) {
    return {
      decision: "deny",
      matchedRule: "",
      reason: `规则键非法：${ruleKey}`,
    };
  }
  const sameName = (list: string[], decision: RuleDecision): RuleEvaluation | undefined => {
    for (const raw of list) {
      const rule = parseRule(raw);
      if (!rule || !nameMatches(rule.name, parsedKey.name)) {
        continue;
      }
      const hit =
        rule.spec === undefined ||
        (parsedKey.spec !== undefined && matchSpec(rule.spec, parsedKey.spec));
      if (hit) {
        return {
          decision,
          matchedRule: rule.raw,
          reason: `命中${decision === "deny" ? "拒绝" : decision === "ask" ? "询问" : "允许"}规则 ${rule.raw}`,
        };
      }
    }
    return undefined;
  };

  const denied = sameName(rules.deny, "deny");
  if (denied) {
    return denied;
  }
  const asked = sameName(rules.ask, "ask");
  if (asked) {
    return asked;
  }
  const allowed = sameName(rules.allow, "allow");
  if (allowed) {
    return allowed;
  }
  return defaultDecision(level, approval, category, ruleKey);
}
