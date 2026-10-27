import { describe, it, expect } from "vitest";
import {
  toPascalCase,
  stripAnsi,
  displayWidth,
  padToWidth,
  truncateToWidth,
} from "../src/shared/string";

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

describe("stripAnsi", () => {
  it("去除色码保留纯文本", () => {
    expect(stripAnsi("\x1b[32m绿色\x1b[0m")).toBe("绿色");
  });

  it("无色码时原样返回", () => {
    expect(stripAnsi("纯文本")).toBe("纯文本");
  });

  it("去除多段色码", () => {
    expect(stripAnsi("\x1b[1;36m❯\x1b[0m /thi\x1b[22m")).toBe("❯ /thi");
  });
});

describe("displayWidth", () => {
  it("ASCII 字符按 1 列计", () => {
    expect(displayWidth("abc /th")).toBe(7);
  });

  it("全角字符按 2 列计", () => {
    expect(displayWidth("中文")).toBe(4);
  });

  it("中英混排按实际列数计", () => {
    expect(displayWidth("你 > hi")).toBe(7);
  });

  it("emoji 代理对只计一次宽度", () => {
    expect(displayWidth("👍")).toBe(2);
  });

  it("空字符串宽度为 0", () => {
    expect(displayWidth("")).toBe(0);
  });
});

describe("padToWidth", () => {
  it("补齐到目标宽度", () => {
    expect(padToWidth("ab", 5)).toBe("ab   ");
  });

  it("全角字符按显示宽度补齐", () => {
    expect(padToWidth("中", 4)).toBe("中  ");
  });

  it("已超宽时原样返回", () => {
    expect(padToWidth("abcde", 3)).toBe("abcde");
  });
});

describe("truncateToWidth", () => {
  it("不超宽时原样返回", () => {
    expect(truncateToWidth("abc", 5)).toBe("abc");
  });

  it("超宽时截断并以省略号结尾", () => {
    expect(truncateToWidth("abcdef", 5)).toBe("abcd…");
  });

  it("全角字符按 2 列参与截断", () => {
    // "中中中" 显示宽度 6，上限 5 → 放下 "中中"（4 列）+ 省略号（1 列）
    expect(truncateToWidth("中中中", 5)).toBe("中中…");
  });

  it("上限为 0 时返回空串", () => {
    expect(truncateToWidth("abc", 0)).toBe("");
  });
});
