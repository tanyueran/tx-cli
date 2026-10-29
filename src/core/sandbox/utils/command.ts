/**
 * 命令文本处理工具：复合命令切分、包装前缀剥离与空白折叠
 * 纯字符串处理，不感知沙箱档位与规则内容
 */

/** 无参数执行的包装前缀命令（穿透剥离用） */
const WRAPPER_PREFIXES = new Set(["env", "nohup", "xargs"]);

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
