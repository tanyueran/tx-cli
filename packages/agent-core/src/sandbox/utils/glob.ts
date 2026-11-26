/**
 * 沙箱 glob 编译工具：把通配符模式编译为锚定正则，不做任何判定决策
 * 两套语义按用途区分：规则细粒度匹配用 compileGlob（* 可跨 /），
 * 路径边界匹配用 compilePathGlob（** 跨目录、* 仅单段内）
 */

/**
 * 把简化 glob 模式编译为正则：* 匹配任意字符序列，其余按字面量转义
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
 * 把含通配符的路径模式编译为正则：** 跨目录匹配任意字符，* 仅匹配单段内字符（不含 /）
 * 通配符先作分隔符拿掉再转义剩余字面量，避免转义后的反斜杠干扰通配符语义
 * @param {string} pattern - 含 * 或 ** 的路径模式
 * @returns {RegExp} 锚定首尾的正则
 */
export function compilePathGlob(pattern: string): RegExp {
  const regexSource = pattern
    .split("**")
    .map((segment) =>
      segment
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${regexSource}$`);
}
