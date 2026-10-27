import pico from "picocolors";
import type { Tool, ToolOutput } from "../types";

/** 任务状态：待办 / 进行中 / 已完成 */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** 单条任务项 */
export interface TodoItem {
  /** 任务描述 */
  content: string;
  /** 当前状态 */
  status: TodoStatus;
}

/** 任务清单工具句柄：工具实例 + 清单状态读取器（REPL /todos 内联命令展示用） */
export interface TodoToolHandle {
  /** write_todos 工具实例 */
  tool: Tool;
  /**
   * 读取当前任务清单（会话级状态，随工具实例存活）
   * @returns {TodoItem[]} 当前清单（数组副本，外部修改不影响工具状态）
   */
  getTodos(): TodoItem[];
}

/** 单次清单的任务项数量上限：防止清单膨胀失控、挤占上下文 */
const MAX_TODO_ITEMS = 20;

/** 合法的任务状态取值（参数 schema 的 enum 与校验共用） */
const TODO_STATUSES: TodoStatus[] = ["pending", "in_progress", "completed"];

/**
 * 格式化任务清单为多行展示文本（工具调用提示与 /todos 内联命令共用）
 * 符号约定：☐ 待办、◐ 进行中（黄字）、☑ 已完成（暗色弱化）
 * @param {TodoItem[]} todos - 任务清单
 * @returns {string} 逐行展示文本（每行两空格缩进，不含首行标题）
 */
export function formatTodoList(todos: TodoItem[]): string {
  return todos
    .map((todo) => {
      if (todo.status === "completed") {
        return `  ${pico.dim("☑ " + todo.content)}`;
      }
      if (todo.status === "in_progress") {
        return `  ${pico.yellow("◐ " + todo.content)}`;
      }
      return `  ☐ ${todo.content}`;
    })
    .join("\n");
}

/**
 * 校验并解析模型给出的清单参数（execute 与 renderCall 共用）
 * 规则：todos 必须为数组（空数组视为清空清单）；每项 content 非空、status 合法；总量不超过 MAX_TODO_ITEMS
 * @param {Record<string, unknown>} args - 模型给出的参数
 * @returns {TodoItem[] | string} 解析成功返回清单，失败返回错误说明（回传模型自纠）
 */
function parseTodoItems(args: Record<string, unknown>): TodoItem[] | string {
  const rawTodos = args.todos;
  if (!Array.isArray(rawTodos)) {
    return "缺少 todos 数组参数（传入完整任务清单，空数组表示清空）";
  }
  if (rawTodos.length > MAX_TODO_ITEMS) {
    return `任务清单最多 ${MAX_TODO_ITEMS} 项，收到 ${rawTodos.length} 项，请精简后再提交`;
  }
  const parsedTodos: TodoItem[] = [];
  for (const [index, rawTodo] of rawTodos.entries()) {
    const content =
      typeof rawTodo?.content === "string" ? rawTodo.content.trim() : "";
    if (!content) {
      return `todos[${index}].content 不能为空`;
    }
    const status = rawTodo?.status;
    if (!TODO_STATUSES.includes(status)) {
      return `todos[${index}].status 必须为 ${TODO_STATUSES.join("|")} 之一`;
    }
    parsedTodos.push({ content, status });
  }
  return parsedTodos;
}

/**
 * 生成回传给模型的执行摘要：确认清单已更新并给出计数，附加进行中任务提醒
 * @param {TodoItem[]} todos - 已写入的清单
 * @returns {string} 摘要文本
 */
function buildModelSummary(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return "任务清单已清空";
  }
  const inProgressCount = todos.filter(
    (todo) => todo.status === "in_progress",
  ).length;
  const completedCount = todos.filter(
    (todo) => todo.status === "completed",
  ).length;
  const lines = [
    `任务清单已更新（共 ${todos.length} 项：${completedCount} 已完成 / ${inProgressCount} 进行中 / ${todos.length - completedCount - inProgressCount} 待办）`,
  ];
  if (inProgressCount > 1) {
    lines.push("提醒：进行中任务超过 1 项，建议聚焦单个任务推进");
  }
  return lines.join("\n");
}

/**
 * 内置工具：任务清单（write_todos，agent 模式装配）
 * 全量替换语义：每次调用提交完整清单，状态保存在工具实例闭包内（会话级，退出即失）；
 * 供模型在多步任务中维护计划载体，调用提示经 renderCall 渲染为清单视图，REPL 可用 /todos 查看；
 * 纯内存操作，不声明 permission（权限门卫原样放行）
 * @returns {TodoToolHandle} 工具句柄（工具实例 + 清单读取器）
 */
export function createTodoTool(): TodoToolHandle {
  let todos: TodoItem[] = [];
  const tool: Tool = {
    name: "write_todos",
    description:
      "写入或更新任务清单（全量替换，每次传入完整清单）：用于多步任务的计划维护——" +
      "开始 3 步以上的任务前先建立清单，每完成一项即将其置为 completed；" +
      "同一时刻建议仅一项 in_progress；简单任务不必使用。状态取值：" +
      TODO_STATUSES.join(" | "),
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: `完整任务清单（最多 ${MAX_TODO_ITEMS} 项），空数组表示清空`,
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "任务描述（祈使句，如「修复 config 加载的时序问题」）",
              },
              status: {
                type: "string",
                enum: [...TODO_STATUSES],
                description: "任务状态",
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    /**
     * 调用提示渲染：展示即将写入的清单视图（替代原始 JSON 参数打印）
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string} 清单展示文本（首行为摘要，随后为逐项清单）
     */
    renderCall(args: Record<string, unknown>): string {
      const parsedTodos = parseTodoItems(args);
      if (typeof parsedTodos === "string") {
        return `（清单参数无效：${parsedTodos}）`;
      }
      if (parsedTodos.length === 0) {
        return "清空任务清单";
      }
      const inProgressCount = parsedTodos.filter(
        (todo) => todo.status === "in_progress",
      ).length;
      const completedCount = parsedTodos.filter(
        (todo) => todo.status === "completed",
      ).length;
      return (
        `更新任务清单（${parsedTodos.length} 项：${completedCount} 完成 / ${inProgressCount} 进行中 / ${parsedTodos.length - completedCount - inProgressCount} 待办）\n` +
        formatTodoList(parsedTodos)
      );
    },
    /**
     * 执行清单写入：参数校验失败转为失败输出回传模型自纠；成功则全量替换会话状态
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {Promise<ToolOutput>} 写入结果摘要或错误说明
     */
    async execute(args: Record<string, unknown>): Promise<ToolOutput> {
      const parsedTodos = parseTodoItems(args);
      if (typeof parsedTodos === "string") {
        return { ok: false, output: parsedTodos };
      }
      todos = parsedTodos;
      return { ok: true, output: buildModelSummary(parsedTodos) };
    },
  };
  return { tool, getTodos: () => todos.map((todo) => ({ ...todo })) };
}
