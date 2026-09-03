import { describe, it, expect } from "vitest";
import { disposeOnesInfo } from "../src/core/ones-message";

describe("disposeOnesInfo", () => {
  it("标准ones信息：带#id、标题和url", () => {
    const result = disposeOnesInfo(
      "#532311 【资产化中心】优化批量设置扩展属性时【多选自定义】入参。\nhttps://ones.cisdigital.cn/xxxxx"
    );
    expect(result).toBe(
      "fix(#532311): 【资产化中心】优化批量设置扩展属性时【多选自定义】入参。"
    );
  });

  it("只有id和标题，没有url", () => {
    const result = disposeOnesInfo("#532311 优化属性设置");
    expect(result).toBe("fix(#532311): 优化属性设置");
  });

  it("不以#开头时原样返回", () => {
    const result = disposeOnesInfo("feat: 普通提交");
    expect(result).toBe("feat: 普通提交");
  });

  it("#开头但没有数字id时原样返回", () => {
    const result = disposeOnesInfo("#no-id 测试");
    expect(result).toBe("#no-id 测试");
  });

  it("只有#号时原样返回", () => {
    const result = disposeOnesInfo("#");
    expect(result).toBe("#");
  });
});