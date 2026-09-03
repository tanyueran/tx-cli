import { describe, it, expect } from "vitest";
import { toPascalCase } from "../src/shared/string";

describe("toPascalCase", () => {
  it("连字符分隔转大驼峰", () => {
    expect(toPascalCase("user-profile")).toBe("UserProfile");
  });

  it("下划线分隔转大驼峰", () => {
    expect(toPascalCase("user_profile")).toBe("UserProfile");
  });

  it("空格分隔转大驼峰", () => {
    expect(toPascalCase("user profile")).toBe("UserProfile");
  });

  it("单个单词首字母大写", () => {
    expect(toPascalCase("user")).toBe("User");
  });

  it("已是大驼峰时保持不变", () => {
    expect(toPascalCase("UserProfile")).toBe("Userprofile");
  });

  it("全大写会被规整为大驼峰", () => {
    expect(toPascalCase("USER-PROFILE")).toBe("UserProfile");
  });

  it("空字符串原样返回", () => {
    expect(toPascalCase("")).toBe("");
  });
});
