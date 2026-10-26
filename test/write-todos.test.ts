import { describe, expect, it } from "vitest";
import { createTodoTool, formatTodoList } from "../src/core/tools";
import type { TodoItem } from "../src/core/tools";

/** 构造一条任务项的快捷函数 */
function todo(content: string, status: TodoItem["status"]): TodoItem {
  return { content, status };
}

describe("write_todos 工具", () => {
  it("合法清单写入成功，getTodos 返回状态副本", async () => {
    const { tool, getTodos } = createTodoTool();
    const result = await tool.execute({
      todos: [todo("调研链路", "completed"), todo("实现工具", "in_progress")],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("共 2 项");
    expect(getTodos()).toEqual([
      todo("调研链路", "completed"),
      todo("实现工具", "in_progress"),
    ]);
    // 返回副本：外部修改不污染工具状态
    getTodos().pop();
    expect(getTodos()).toHaveLength(2);
  });

  it("两次调用为全量替换语义", async () => {
    const { tool, getTodos } = createTodoTool();
    await tool.execute({
      todos: [todo("a", "pending"), todo("b", "pending"), todo("c", "pending")],
    });
    await tool.execute({ todos: [todo("只做这个", "in_progress")] });

    expect(getTodos()).toEqual([todo("只做这个", "in_progress")]);
  });

  it("空数组清空清单", async () => {
    const { tool, getTodos } = createTodoTool();
    await tool.execute({ todos: [todo("a", "pending")] });
    const result = await tool.execute({ todos: [] });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("已清空");
    expect(getTodos()).toEqual([]);
  });

  it("非数组 todos 转为失败输出回传模型", async () => {
    const { tool, getTodos } = createTodoTool();
    const result = await tool.execute({ todos: "清理仓库" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("todos 数组");
    expect(getTodos()).toEqual([]);
  });

  it("缺少 todos 参数转为失败输出", async () => {
    const { tool } = createTodoTool();
    const result = await tool.execute({});

    expect(result.ok).toBe(false);
    expect(result.output).toContain("todos 数组");
  });

  it.each([
    ["content 为空串", [{ content: "  ", status: "pending" }], "content 不能为空"],
    [
      "status 非法",
      [{ content: "a", status: "doing" }],
      "status 必须为",
    ],
    ["元素缺失 content", [{ status: "pending" }], "content 不能为空"],
  ])("%s 时转为失败输出", async (_name, todos, expected) => {
    const { tool, getTodos } = createTodoTool();
    const result = await tool.execute({ todos });

    expect(result.ok).toBe(false);
    expect(result.output).toContain(expected);
    expect(getTodos()).toEqual([]);
  });

  it("清单超过 20 项转为失败输出", async () => {
    const { tool, getTodos } = createTodoTool();
    const todos = Array.from({ length: 21 }, (_, i) =>
      todo(`任务 ${i + 1}`, "pending"),
    );
    const result = await tool.execute({ todos });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("最多 20 项");
    expect(getTodos()).toEqual([]);
  });

  it("进行中任务超过 1 项时在摘要中提醒", async () => {
    const { tool } = createTodoTool();
    const result = await tool.execute({
      todos: [todo("a", "in_progress"), todo("b", "in_progress")],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("超过 1 项");
  });
});

describe("formatTodoList 与 renderCall", () => {
  it("按状态渲染符号清单", () => {
    const text = formatTodoList([
      todo("已完成项", "completed"),
      todo("进行中项", "in_progress"),
      todo("待办项", "pending"),
    ]);
    const plain = text.replace(
      // eslint-disable-next-line no-control-regex
      /\u001b\[\d+m/g,
      "",
    );

    expect(plain).toContain("☑ 已完成项");
    expect(plain).toContain("◐ 进行中项");
    expect(plain).toContain("☐ 待办项");
  });

  it("renderCall 输出摘要行与清单视图", () => {
    const { tool } = createTodoTool();
    const text = tool.renderCall?.({
      todos: [todo("写代码", "in_progress"), todo("补测试", "pending")],
    });

    expect(text).toContain("更新任务清单（2 项");
    expect(text).toContain("◐ 写代码");
    expect(text).toContain("☐ 补测试");
  });

  it("renderCall 对空清单输出清空提示", () => {
    const { tool } = createTodoTool();
    expect(tool.renderCall?.({ todos: [] })).toContain("清空任务清单");
  });

  it("renderCall 对非法参数输出无效提示", () => {
    const { tool } = createTodoTool();
    expect(tool.renderCall?.({ todos: "not-array" })).toContain("参数无效");
  });
});
