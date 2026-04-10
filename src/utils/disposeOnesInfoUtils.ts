/**
 * 处理ones上的信息，将其改为fix(【id】): 【title】格式
 *  示例：
 *    #532311 【资产化中心】优化批量设置扩展属性时【多选自定义】入参。（【多选自定义】没传attributeValue，【多选人员&组织】传了空数组）
 *     https://ones.cisdigital.cn/xxxxx
 *  处理后：
 *    fix(532311): 【资产化中心】优化批量设置扩展属性时【多选自定义】入参。（【多选自定义】没传attributeValue，【多选人员&组织】传了空数组）
 * @param message
 * @returns
 */
export function disposeOnesInfo(message: string) {
  if (message.startsWith("#")) {
    try {
      const [info, _url] = message.split(/\n/);
      const id = info.match(/#\d+/)?.[0] || "";
      const title = info.replace(id, "").trim();
      return `fix(${id}): ${title}`;
    } catch (err) {
      console.error(err);
      return message;
    }
  } else {
    return message;
  }
}
