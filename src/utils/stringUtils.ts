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
