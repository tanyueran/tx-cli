import { describe, it, expect } from "vitest";
import pico from "picocolors";
import {
  ReplInputController,
  renderReplFrame,
  PANEL_LIMIT,
} from "../src/core/conversation/common/repl-input";
import type { ReplSuggestion } from "../src/core/conversation/common/repl-input";
import { stripAnsi } from "../src/shared/string";

/** 构造固定候选的 suggest 回调 */
function suggestOf(suggestions: ReplSuggestion[]) {
  return () => suggestions;
}

/** 面板候选样例：覆盖命令带参数占位与无参数两种形态 */
const COMMAND_SUGGESTIONS: ReplSuggestion[] = [
  { name: "/think", description: "查看或切换思考档位", args: "<off|low|medium|high>" },
  { name: "/skill", description: "加载技能手册后执行任务", args: "<name> [任务...]" },
  { name: "/skills", description: "列出可用技能及来源" },
  { name: "/help", description: "列出全部斜杠命令" },
];

/** 模拟按键序列：依次喂入状态机，返回各次 outcome */
function feed(
  controller: ReplInputController,
  events: Array<
    [string | undefined, { name?: string; ctrl?: boolean; meta?: boolean } | undefined]
  >,
) {
  return events.map(([str, key]) => controller.keypress(str, key));
}

describe("ReplInputController 基础编辑", () => {
  it("可打印字符插入并后移光标", () => {
    const controller = new ReplInputController(suggestOf([]));
    controller.keypress("a", undefined);
    controller.keypress("b", { name: undefined });
    expect(controller.input).toBe("ab");
    expect(controller.cursor).toBe(2);
  });

  it("backspace 删除光标前字符", () => {
    const controller = new ReplInputController(suggestOf([]));
    feed(controller, [["h", undefined], ["i", undefined], [undefined, { name: "backspace" }]]);
    expect(controller.input).toBe("h");
    expect(controller.cursor).toBe(1);
  });

  it("backspace 按代理对整体删除 emoji", () => {
    const controller = new ReplInputController(suggestOf([]));
    controller.keypress("👍", undefined);
    expect(controller.cursor).toBe(2);
    controller.keypress(undefined, { name: "backspace" });
    expect(controller.input).toBe("");
    expect(controller.cursor).toBe(0);
  });

  it("left/right 光标移动（代理对感知）", () => {
    const controller = new ReplInputController(suggestOf([]));
    controller.keypress("a", undefined);
    controller.keypress("👍", undefined);
    feed(controller, [
      [undefined, { name: "left" }],
      [undefined, { name: "left" }],
    ]);
    expect(controller.cursor).toBe(0);
    // 右移两次：第一次跨过 'a'，第二次跨过整个代理对
    feed(controller, [
      [undefined, { name: "right" }],
      [undefined, { name: "right" }],
    ]);
    expect(controller.cursor).toBe(3);
  });

  it("home/end/ctrl+a/ctrl+e 定位行首行尾", () => {
    const controller = new ReplInputController(suggestOf([]));
    controller.keypress("a", undefined);
    controller.keypress("b", undefined);
    feed(controller, [[undefined, { name: "home" }]]);
    expect(controller.cursor).toBe(0);
    feed(controller, [[undefined, { name: "end" }]]);
    expect(controller.cursor).toBe(2);
    feed(controller, [[undefined, { ctrl: true, name: "a" }]]);
    expect(controller.cursor).toBe(0);
    feed(controller, [[undefined, { ctrl: true, name: "e" }]]);
    expect(controller.cursor).toBe(2);
  });

  it("ctrl+u 清到行首 / ctrl+k 清到行尾", () => {
    const controller = new ReplInputController(suggestOf([]));
    controller.input = "abcdef";
    controller.cursor = 3;
    controller.keypress(undefined, { ctrl: true, name: "u" });
    expect(controller.input).toBe("def");
    controller.input = "abcdef";
    controller.cursor = 3;
    controller.keypress(undefined, { ctrl: true, name: "k" });
    expect(controller.input).toBe("abc");
  });
});

describe("ReplInputController 提交与取消", () => {
  it("空输入回车响铃不提交", () => {
    const controller = new ReplInputController(suggestOf([]));
    expect(controller.keypress(undefined, { name: "return" })).toEqual({ type: "bell" });
  });

  it("非空输入回车提交", () => {
    const controller = new ReplInputController(suggestOf([]));
    controller.keypress("h", undefined);
    expect(controller.keypress(undefined, { name: "return" })).toEqual({ type: "submit" });
  });

  it("ctrl+c 取消", () => {
    const controller = new ReplInputController(suggestOf([]));
    expect(controller.keypress(undefined, { ctrl: true, name: "c" })).toEqual({ type: "cancel" });
  });

  it("ctrl+d 仅空输入时取消，非空时忽略", () => {
    const controller = new ReplInputController(suggestOf([]));
    expect(controller.keypress(undefined, { ctrl: true, name: "d" })).toEqual({ type: "cancel" });
    const withInput = new ReplInputController(suggestOf([]));
    withInput.keypress("h", undefined);
    expect(withInput.keypress(undefined, { ctrl: true, name: "d" })).toEqual({ type: "none" });
    expect(withInput.input).toBe("h");
  });

  it("面板打开时 Esc 仅关闭面板，再次 Esc 取消", () => {
    const controller = new ReplInputController(suggestOf(COMMAND_SUGGESTIONS));
    controller.keypress("/", undefined);
    expect(controller.panelVisible).toBe(true);
    expect(controller.keypress(undefined, { name: "escape" })).toEqual({ type: "none" });
    expect(controller.panelVisible).toBe(false);
    expect(controller.keypress(undefined, { name: "escape" })).toEqual({ type: "cancel" });
  });
});

describe("ReplInputController 补全面板", () => {
  it("输入 / 后面板可见，普通输入不弹面板", () => {
    const controller = new ReplInputController(suggestOf(COMMAND_SUGGESTIONS));
    expect(controller.panelVisible).toBe(false);
    controller.keypress("h", undefined);
    expect(controller.panelVisible).toBe(false);
    // 新开一行输入 "/"：面板出现并列出全部候选
    const slashController = new ReplInputController(suggestOf(COMMAND_SUGGESTIONS));
    slashController.keypress("/", undefined);
    expect(slashController.panelVisible).toBe(true);
    expect(slashController.suggestions).toHaveLength(4);
    expect(slashController.selection).toBe(0);
  });

  it("面板打开时 ↑↓ 移动高亮并环绕", () => {
    const controller = new ReplInputController(suggestOf(COMMAND_SUGGESTIONS));
    controller.keypress("/", undefined);
    controller.keypress(undefined, { name: "up" });
    expect(controller.selection).toBe(3);
    controller.keypress(undefined, { name: "down" });
    expect(controller.selection).toBe(0);
    controller.keypress(undefined, { name: "down" });
    expect(controller.selection).toBe(1);
  });

  it("面板打开时 ↑↓ 不触发历史回溯", () => {
    const history = ["hello"];
    const controller = new ReplInputController(suggestOf(COMMAND_SUGGESTIONS), history);
    controller.keypress("/", undefined);
    controller.keypress(undefined, { name: "up" });
    expect(controller.input).toBe("/");
  });

  it("Tab 用高亮候选替换当前 token，行尾补空格", () => {
    const controller = new ReplInputController(suggestOf(COMMAND_SUGGESTIONS));
    feed(controller, [["/", undefined], ["t", undefined], ["h", undefined]]);
    expect(controller.input).toBe("/th");
    const outcome = controller.keypress(undefined, { name: "tab" });
    expect(outcome).toEqual({ type: "none" });
    expect(controller.input).toBe("/think ");
    expect(controller.cursor).toBe(7);
  });

  it("Tab 在已有候选参数后继续编辑，光标不在行尾时不追加空格", () => {
    const controller = new ReplInputController(suggestOf(COMMAND_SUGGESTIONS));
    controller.input = "/th|x";
    controller.cursor = 3;
    controller.keypress(undefined, { name: "tab" });
    expect(controller.input).toBe("/think|x");
    expect(controller.cursor).toBe(6);
  });

  it("Tab 对无参数候选不追加空格", () => {
    const controller = new ReplInputController(suggestOf(COMMAND_SUGGESTIONS));
    controller.input = "/hel";
    controller.cursor = 4;
    // 选中第 4 项 /help（无参数占位）
    controller.selection = 3;
    controller.keypress(undefined, { name: "tab" });
    expect(controller.input).toBe("/help");
  });

  it("Tab 在 /skill 后进入技能二级补全", () => {
    const skillSuggestions: ReplSuggestion[] = [
      { name: "review", description: "评审" },
      { name: "refactor", description: "重构" },
    ];
    const controller = new ReplInputController(suggestOf(skillSuggestions));
    controller.input = "/skill rev";
    controller.cursor = 10;
    controller.keypress(undefined, { name: "tab" });
    expect(controller.input).toBe("/skill review");
    expect(controller.cursor).toBe(13);
  });

  it("无候选时 Tab 响铃", () => {
    const controller = new ReplInputController(suggestOf([]));
    controller.input = "/x";
    controller.cursor = 2;
    expect(controller.keypress(undefined, { name: "tab" })).toEqual({ type: "bell" });
  });

  it("Esc 关闭面板后继续编辑自动重开", () => {
    const controller = new ReplInputController(suggestOf(COMMAND_SUGGESTIONS));
    controller.keypress("/", undefined);
    controller.keypress(undefined, { name: "escape" });
    expect(controller.panelVisible).toBe(false);
    controller.keypress("h", undefined);
    expect(controller.panelVisible).toBe(true);
  });
});

describe("ReplInputController 输入历史（P2）", () => {
  it("空历史按 ↑ 响铃", () => {
    const controller = new ReplInputController(suggestOf([]), []);
    expect(controller.keypress(undefined, { name: "up" })).toEqual({ type: "bell" });
  });

  it("↑ 从最后一条开始回溯，↑ 到顶响铃", () => {
    const controller = new ReplInputController(suggestOf([]), ["a", "b"]);
    controller.keypress(undefined, { name: "up" });
    expect(controller.input).toBe("b");
    controller.keypress(undefined, { name: "up" });
    expect(controller.input).toBe("a");
    expect(controller.keypress(undefined, { name: "up" })).toEqual({ type: "bell" });
    expect(controller.input).toBe("a");
  });

  it("↓ 后移历史，翻过最后一条恢复进入前的草稿", () => {
    const controller = new ReplInputController(suggestOf([]), ["a", "b"]);
    controller.input = "draft";
    controller.cursor = 5;
    controller.keypress(undefined, { name: "up" });
    expect(controller.input).toBe("b");
    controller.keypress(undefined, { name: "up" });
    expect(controller.input).toBe("a");
    // down 回到 "b"，再 down 恢复草稿
    controller.keypress(undefined, { name: "down" });
    expect(controller.input).toBe("b");
    expect(controller.keypress(undefined, { name: "down" })).toEqual({ type: "none" });
    expect(controller.input).toBe("draft");
    expect(controller.cursor).toBe(5);
    expect(controller.keypress(undefined, { name: "down" })).toEqual({ type: "bell" });
  });

  it("回溯后编辑即脱离历史态", () => {
    const controller = new ReplInputController(suggestOf([]), ["a", "b"]);
    controller.keypress(undefined, { name: "up" });
    controller.keypress("c", undefined);
    expect(controller.input).toBe("bc");
    // 已脱离历史态：↓ 不再回历史
    expect(controller.keypress(undefined, { name: "down" })).toEqual({ type: "bell" });
  });

  it("历史条目以 / 开头时取出后面板自动出现", () => {
    const controller = new ReplInputController(suggestOf(COMMAND_SUGGESTIONS), ["/help"]);
    controller.keypress(undefined, { name: "up" });
    expect(controller.input).toBe("/help");
    expect(controller.panelVisible).toBe(true);
  });
});

describe("ReplInputController bracketed paste", () => {
  it("粘贴区间内换行单行化为空格，不触发提交", () => {
    const controller = new ReplInputController(suggestOf([]));
    controller.keypress(undefined, { name: "paste-start" });
    // 模拟真实终端粘贴：整段文本（含 CRLF）作为一次 keypress 到达
    controller.keypress("h\r\ni", undefined);
    controller.keypress(undefined, { name: "paste-end" });
    expect(controller.input).toBe("h i");
    // 粘贴结束后回车恢复正常提交语义
    expect(controller.keypress(undefined, { name: "return" })).toEqual({ type: "submit" });
  });

  it("粘贴区间内的 Tab 转为空格而非触发补全", () => {
    const controller = new ReplInputController(suggestOf(COMMAND_SUGGESTIONS));
    controller.input = "/th";
    controller.cursor = 3;
    controller.keypress(undefined, { name: "paste-start" });
    controller.keypress("\t", undefined);
    expect(controller.input).toBe("/th ");
    controller.keypress(undefined, { name: "paste-end" });
  });
});

describe("renderReplFrame", () => {
  it("首行为提示词 + 输入，光标列按显示宽度计算（CJK）", () => {
    const controller = new ReplInputController(suggestOf([]));
    controller.input = "你好";
    controller.cursor = 1;
    const frame = renderReplFrame(controller, { message: pico.green("你 > "), columns: 80 });
    // 提示词 "你 > " 显示宽度 5（含色码先剥离），"你" 宽 2
    expect(frame.text.startsWith(`${pico.green("你 > ")}你好`)).toBe(true);
    expect(frame.cursorColumn).toBe(7);
    expect(frame.lineCount).toBe(1);
  });

  it("光标列被 clamp 到 columns-1", () => {
    const controller = new ReplInputController(suggestOf([]));
    controller.input = "abcdefghijklmnopqrstuvwxyz0123456789";
    controller.cursor = controller.input.length;
    const frame = renderReplFrame(controller, { message: "> ", columns: 20 });
    expect(frame.cursorColumn).toBe(19);
  });

  it("面板可见时渲染候选行，选中行带 ❯ 标记", () => {
    const controller = new ReplInputController(suggestOf(COMMAND_SUGGESTIONS));
    controller.input = "/";
    controller.cursor = 1;
    const frame = renderReplFrame(controller, { message: "> ", columns: 80 });
    const lines = frame.text.split("\n");
    // 4 条候选 → 1 输入行 + 4 面板行
    expect(frame.lineCount).toBe(5);
    const plainLines = lines.map((line) => stripAnsi(line));
    expect(plainLines[1]).toContain("❯ /think");
    expect(plainLines[1]).toContain("查看或切换思考档位");
    expect(plainLines[4]).toContain("/help");
  });

  it("无匹配时渲染占位提示行", () => {
    const controller = new ReplInputController(suggestOf([]));
    controller.input = "/";
    controller.cursor = 1;
    const frame = renderReplFrame(controller, { message: "> ", columns: 80 });
    expect(stripAnsi(frame.text.split("\n")[1])).toContain("无匹配命令");
  });

  it("超过面板上限时仅展示 10 条并带滚动指示", () => {
    const many: ReplSuggestion[] = Array.from({ length: 13 }, (_, i) => ({
      name: `/cmd${i}`,
      description: `命令${i}`,
    }));
    const controller = new ReplInputController(suggestOf(many));
    controller.input = "/";
    controller.cursor = 1;
    const frame = renderReplFrame(controller, { message: "> ", columns: 80 });
    const lines = frame.text.split("\n").map((line) => stripAnsi(line));
    // 顶部无指示、底部有「↓ 还有 N 条」，实际行数 = 1 + 10 + 1
    expect(lines[1]).not.toContain("↑ 还有");
    expect(lines[1]).toContain("/cmd0");
    expect(lines[PANEL_LIMIT]).toContain("/cmd9");
    expect(lines[PANEL_LIMIT + 1]).toContain("↓ 还有 3 条");
    expect(frame.lineCount).toBe(PANEL_LIMIT + 2);
  });

  it("高亮项下移时窗口随之滚动并出现顶部指示", () => {
    const many: ReplSuggestion[] = Array.from({ length: 13 }, (_, i) => ({
      name: `/cmd${i}`,
      description: `命令${i}`,
    }));
    const controller = new ReplInputController(suggestOf(many));
    controller.input = "/";
    controller.cursor = 1;
    // 高亮移到第 7 项（下标 6）：窗口起点应为 1
    for (let i = 0; i < 6; i += 1) {
      controller.keypress(undefined, { name: "down" });
    }
    expect(controller.selection).toBe(6);
    const frame = renderReplFrame(controller, { message: "> ", columns: 80 });
    const lines = frame.text.split("\n").map((line) => stripAnsi(line));
    expect(lines[1]).toContain("↑ 还有 1 条");
    expect(lines[2]).toContain("/cmd1");
    expect(lines[11]).toContain("/cmd10");
  });

  it("窄终端下长描述被截断且行宽不超预算", () => {
    const controller = new ReplInputController(
      suggestOf([{ name: "/very-long-command-name", description: "这是一段相当长的中文描述需要被截断" }]),
    );
    controller.input = "/";
    controller.cursor = 1;
    // 24 列时标签预算 19 列：23 列的标签必须截断（desc 被整体丢弃）
    const frame = renderReplFrame(controller, { message: "> ", columns: 24 });
    const line = stripAnsi(frame.text.split("\n")[1]);
    expect(line.length).toBeLessThanOrEqual(24);
    expect(line).toContain("…");
  });
});
