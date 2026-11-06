/**
 * 配置分层合并工具：项目配置与全局配置的统一合并语义
 * 规则：标量/对象高层覆盖低层，数组并集去重（低层在前、高层在后，保持配置顺序语义）；
 * llm/sandbox/mcpServers 各段的「项目 > 全局」合并均复用此处实现
 */

/**
 * 合并字符串数组：低优先级在前、高优先级在后追加，重复项去重（保留首次出现位置）
 * @param {string[]} low - 低优先级数组（如全局配置）
 * @param {string[]} high - 高优先级数组（如项目配置）
 * @returns {string[]} 合并去重后的新数组
 */
export function mergeStringArrays(low: string[], high: string[]): string[] {
  return [...new Set([...low, ...high])];
}

/**
 * 合并字符串键记录：按 key 合并，高优先级同名覆盖低优先级（浅合并）
 * @param {Record<string, T>} low - 低优先级记录（如全局配置）
 * @param {Record<string, T>} high - 高优先级记录（如项目配置）
 * @returns {Record<string, T>} 合并后的新记录
 */
export function mergeRecords<T>(
  low: Record<string, T>,
  high: Record<string, T>,
): Record<string, T> {
  return { ...low, ...high };
}
