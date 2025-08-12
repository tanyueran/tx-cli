/**
 * 字符串儿转大驼峰
 * @param str 
 * @returns 
 */
export function toPascalCase(str: string) {
  if (!str || typeof str !== "string") return str;

  return str
    .split(/[\s-_]/) // 按空格、下划线或连字符分割
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}
