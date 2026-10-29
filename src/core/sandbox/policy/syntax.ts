/**
 * 规则语法层：规则文本解析与细粒度模式匹配
 * 纯字符串处理，不做任何判定决策；通用 glob 编译与命令切分见 ../utils/
 */

import { compileGlob } from "../utils/glob";

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
