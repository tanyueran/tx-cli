import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatUsageSummary } from "../../llm";
import type {
  LlmPricing,
  ResponseHistoryItem,
  ThinkingLevel,
  TokenUsage,
} from "../../llm/types";

/** 单个工具输出在导出文件中的最大字符数：超出截断，避免超长输出淹没存档 */
const MAX_TOOL_OUTPUT_CHARS = 4000;

/** 会话导出元信息：文件头部展示的会话级信息 */
export interface SessionExportMeta {
  /** 模式标签，如「对话模式」「Agent 模式」 */
  modeLabel: string;
  /** 模型名 */
  model: string;
  /** 当前思考档位 */
  thinkingLevel: ThinkingLevel;
  /** 会话累计用量 */
  usage: TokenUsage;
  /** 费用单价配置（未配置时头部不展示费用） */
  pricing?: LlmPricing;
  /** 导出时间，缺省当前时间 */
  createdAt?: Date;
}

/**
 * 补零到两位
 * @param {number} value - 非负整数
 * @returns {string} 两位文本
 */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 格式化本地时间为可读文本（导出文件头部展示）
 * @param {Date} date - 时间
 * @returns {string} 形如 2026-11-02 15:30:00 的文本
 */
function formatLocalTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

/**
 * 格式化文件名时间戳（精确到毫秒，避免同一秒内多次导出互相覆盖）
 * @param {Date} date - 时间
 * @returns {string} 形如 20261102-153045-123 的文本
 */
function formatFileStamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}-` +
    String(date.getMilliseconds()).padStart(3, "0")
  );
}

/**
 * 截断超长工具输出并标注原长度
 * @param {string} output - 工具结果原文
 * @returns {string} 可直接放入代码块的文本
 */
function truncateToolOutput(output: string): string {
  const normalized = output.trim();
  if (!normalized) {
    return "（空输出）";
  }
  if (normalized.length <= MAX_TOOL_OUTPUT_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n…（已截断，原长度 ${normalized.length} 字符）`;
}

/**
 * 格式化工具调用参数：合法 JSON 时美化，否则原样保留
 * @param {string} args - 模型给出的参数 JSON 字符串
 * @returns {{ language: string; text: string }} 代码块语言与正文
 */
function formatArguments(args: string): { language: string; text: string } {
  try {
    return { language: "json", text: JSON.stringify(JSON.parse(args), null, 2) };
  } catch {
    return { language: "text", text: args };
  }
}

/**
 * 把会话历史序列化为 Markdown 存档
 * 消息按原始顺序输出；工具调用与结果按 callId 配对展示，超长工具输出截断
 * @param {ResponseHistoryItem[]} history - 会话历史
 * @param {SessionExportMeta} meta - 会话元信息
 * @returns {string} Markdown 文本
 */
export function formatSessionMarkdown(
  history: ResponseHistoryItem[],
  meta: SessionExportMeta,
): string {
  const createdAt = meta.createdAt ?? new Date();
  const callNames = new Map<string, string>();
  for (const item of history) {
    if (item.type === "function_call") {
      callNames.set(item.callId, item.name);
    }
  }

  const lines: string[] = [
    "# tx-cli 会话记录",
    "",
    `- 模式：${meta.modeLabel}`,
    `- 模型：${meta.model} · 思考 ${meta.thinkingLevel}`,
    `- 导出时间：${formatLocalTime(createdAt)}`,
    `- 历史消息：${history.length} 条`,
    `- 累计用量：${formatUsageSummary(meta.usage, meta.pricing)}`,
    "",
  ];

  for (const item of history) {
    if (item.type === "message") {
      const content = item.content.trim();
      if (!content) {
        continue;
      }
      lines.push(item.role === "user" ? "## 用户" : "## 助手", "", content, "");
      continue;
    }
    if (item.type === "function_call") {
      const { language, text } = formatArguments(item.arguments);
      lines.push(
        `### 工具调用 · ${item.name}`,
        "",
        `\`\`\`${language}`,
        text,
        "```",
        "",
      );
      continue;
    }
    const name = callNames.get(item.callId);
    lines.push(
      `### 工具结果${name ? ` · ${name}` : ""}`,
      "",
      "```text",
      truncateToolOutput(item.output),
      "```",
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * 导出会话为 Markdown 文件：写入指定目录（缺省当前工作目录），文件名带毫秒时间戳
 * @param {ResponseHistoryItem[]} history - 会话历史
 * @param {SessionExportMeta} meta - 会话元信息
 * @param {string} [directory] - 目标目录，缺省 process.cwd()
 * @returns {Promise<string>} 写入文件的绝对路径
 */
export async function writeSessionMarkdown(
  history: ResponseHistoryItem[],
  meta: SessionExportMeta,
  directory: string = process.cwd(),
): Promise<string> {
  const createdAt = meta.createdAt ?? new Date();
  const fileName = `tx-cli-session-${formatFileStamp(createdAt)}.md`;
  const filePath = join(directory, fileName);
  await writeFile(
    filePath,
    formatSessionMarkdown(history, { ...meta, createdAt }),
    "utf8",
  );
  return filePath;
}
