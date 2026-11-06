/**
 * 引号包裹路径参数（shell 安全）：已含引号的路径用单引号包裹并转义内部单引号
 * @param {string} path - 原始路径
 * @returns {string} shell 安全的带引号形态
 */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
