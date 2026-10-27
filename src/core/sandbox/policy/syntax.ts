/**
 * 规则语法层：规则文本解析、glob 匹配、复合命令切分与包装剥离
 * 纯字符串处理，不做任何判定决策
 */

/**
 * 规则名归一化映射：用户习惯的短名（Claude Code 风格）→ 内部工具名
 * 规则键（工具侧）与规则（用户侧）都经 parseRule 归一化后匹配，
 * 使 Read(/src/**) 与 read_file(/src/a) 能互相命中
 */
const RULE_NAME_ALIASES: ReadonlyMap<string, string> = new Map([
  ["read", "read_file"],
  ["websearch", "web_search"],
  ["listdir", "list_dir"],
  ["write", "write_file"],
  ["edit", "edit_file"],
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
  toolName: string;
  /** 括号内的细粒度模式；整工具规则（如 WebSearch）无此字段 */
  pattern?: string;
  /** 规则原文（审计与提示用） */
  rawText: string;
}

/**
 * 解析单条规则文本：Name(spec) 细粒度 或 Name 整工具
 * 规则名做别名归一化（Read→read_file 等），使短名规则与内部工具键互相命中；
 * 非法格式返回 undefined，由调用方决定跳过策略
 * @param {string} ruleText - 规则原文，如 `Bash(git push:*)`、`Read(/src/**)`、`WebSearch`
 * @returns {ParsedRule | undefined} 解析结果，非法时为 undefined
 */
export function parseRule(ruleText: string): ParsedRule | undefined {
  const text = ruleText.trim();
  if (!text) {
    return undefined;
  }
  const open = text.indexOf("(");
  if (open === -1) {
    return { toolName: normalizeRuleName(text.toLowerCase()), rawText: text };
  }
  if (!text.endsWith(")")) {
    return undefined;
  }
  const name = normalizeRuleName(text.slice(0, open).trim().toLowerCase());
  const spec = text.slice(open + 1, -1).trim();
  if (!name || !spec) {
    return undefined;
  }
  return { toolName: name, pattern: spec, rawText: text };
}

/**
 * 把 glob 风格模式编译为正则：* 匹配任意字符序列，其余按字面量转义
 * @param {string} pattern - 含通配符的模式
 * @returns {RegExp} 锚定首尾的正则
 */
export function compileGlob(pattern: string): RegExp {
  const escapedPattern = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escapedPattern}$`);
}

/**
 * 匹配细粒度模式与目标文本
 * 三种语法：`cmd` 精确、`prefix:*` 前缀、含 `*` 的 glob
 * @param {string} pattern - 模式（如 git push:*、git status、git log *、/src/**）
 * @param {string} subject - 目标文本（命令段或路径）
 * @returns {boolean} 匹配时为 true
 */
export function matchSpec(pattern: string, subject: string): boolean {
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2).trimEnd();
    return prefix.length > 0 && subject.startsWith(prefix);
  }
  if (pattern.includes("*")) {
    return compileGlob(pattern).test(subject);
  }
  return pattern === subject;
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
  let isEscaped = false;
  for (const character of command) {
    if (isEscaped) {
      current += character;
      isEscaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      isEscaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "&" || character === ";" || character === "|") {
      // && 与 || 消耗两个字符，单 & 也按分隔处理（简化：少见且宽松切分更安全）
      segments.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
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
  let stripped = segment.trim();
  // 循环剥离：VAR=value 与 env/nohup 前缀可交替出现多层
  for (;;) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(\S*)\s+/.exec(stripped);
    if (assignment) {
      stripped = stripped.slice(assignment[0].length);
      continue;
    }
    const firstToken = stripped.split(/\s+/)[0] ?? "";
    if (WRAPPER_PREFIXES.has(firstToken)) {
      // xargs 后可能带自身选项（如 -I{} -n1），仅剥离 xargs 到下一个非选项参数过于复杂，
      // 简化为剥离 xargs token 本身，让后续真实命令暴露给规则匹配
      stripped = stripped.slice(firstToken.length).trim();
      continue;
    }
    return stripped;
  }
}

/**
 * 折叠命令文本中的连续空白为单个空格
 * 避免多个空格绕过精确匹配（如 "git  status"）
 * @param {string} command - 原始文本
 * @returns {string} 折叠后的文本
 */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}
