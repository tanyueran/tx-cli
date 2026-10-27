/**
 * 字符串转大驼峰（PascalCase）
 * 示例：user-profile -> UserProfile
 * @param {string} str - 待转换的字符串，支持空格、下划线、连字符分隔
 * @returns {string} 转换后的大驼峰字符串；入参为空或非字符串时原样返回
 */
export function toPascalCase(str: string) {
  if (!str || typeof str !== "string") return str;

  return str
    .split(/[\s-_]/) // 按空格、下划线或连字符分割
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

/** 匹配 ANSI 转义色码序列（\x1b[...m） */
// eslint-disable-next-line no-control-regex -- 此处必须匹配转义控制字符本身
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * 去除字符串中的 ANSI 色码，得到终端实际展示的纯文本
 * @param {string} text - 可能含色码的字符串
 * @returns {string} 纯文本
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * 计算字符串的终端显示宽度：全角（CJK 等）字符按 2 列、其余按 1 列计
 * 按码点迭代，emoji 等代理对只计一次宽度
 * @param {string} text - 待测宽度的纯文本（含色码时请先经 stripAnsi）
 * @returns {number} 显示宽度（列数）
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += (char.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  }
  return width;
}

/**
 * 将纯文本用空格补齐到指定显示宽度（用于多行纵向上对齐）
 * @param {string} text - 待补齐的纯文本
 * @param {number} width - 目标显示宽度
 * @returns {string} 补齐后的字符串；已超宽时原样返回
 */
export function padToWidth(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
}

/**
 * 将纯文本截断到指定显示宽度，超宽时以「…」结尾
 * @param {string} text - 待截断的纯文本
 * @param {number} maxWidth - 最大显示宽度（≤0 时返回空串）
 * @returns {string} 截断后的字符串
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (displayWidth(text) <= maxWidth) {
    return text;
  }
  let result = "";
  let width = 0;
  // 预留 1 列给省略号
  for (const char of text) {
    const charWidth = (char.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
    if (width + charWidth > maxWidth - 1) {
      break;
    }
    result += char;
    width += charWidth;
  }
  return `${result}…`;
}
