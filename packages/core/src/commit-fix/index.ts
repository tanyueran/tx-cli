/**
 * core/commit-fix：commit-fix 命令的 ONES 消息转换
 */

/**
 * 处理ones上的信息，将其改为fix(【id】): 【title】格式
 *  示例：
 *    #532311 【资产化中心】优化批量设置扩展属性时【多选自定义】入参。（【多选自定义】没传attributeValue，【多选人员&组织】传了空数组）
 *     https://ones.cisdigital.cn/xxxxx
 *  处理后：
 *    fix(#532311): 【资产化中心】优化批量设置扩展属性时【多选自定义】入参。（【多选自定义】没传attributeValue，【多选人员&组织】传了空数组）
 * @param {string} message - ones 上复制的原始信息
 * @returns {string} 转换后的 commit message，不符合格式时原样返回
 */
export function disposeOnesInfo(message: string) {
  if (!message.startsWith("#")) {
    return message;
  }

  const [info] = message.split(/\n/);
  const matched = info.match(/#(\d+)/);
  // 没匹配到 id 时按原样返回，避免生成 fix(): xxx 这种无意义信息
  if (!matched) {
    return message;
  }
  const [idWithHash] = matched;
  const title = info.replace(idWithHash, "").trim();
  return `fix(${idWithHash}): ${title}`;
}
