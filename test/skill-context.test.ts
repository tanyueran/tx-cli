import { describe, it, expect } from "vitest";

import {
  MCP_INLINE_TOOL_LIMIT,
  setupSkillContext,
} from "../src/core/conversation/common/skill-context";
import type { Tool } from "../src/core/tools/types";

/**
 * 构造一个 MCP 形态的假工具（名称带 mcp__ 前缀、描述带服务器前缀）
 * @param {string} name - 工具完整名称
 * @param {string} server - 所属 MCP 服务器名
 * @returns {Tool} 假工具实例
 */
function makeMcpTool(name: string, server = "chrome"): Tool {
  return {
    name,
    description: `[MCP:${server}] ${name} 的描述`,
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: [],
    },
    execute: async () => ({ ok: true, output: `${name} 已执行` }),
  };
}

/**
 * 构造指定数量的 MCP 工具列表
 * @param {number} count - 工具数量
 * @returns {Tool[]} 假工具列表
 */
function makeMcpTools(count: number): Tool[] {
  return Array.from({ length: count }, (_, index) =>
    makeMcpTool(`mcp__chrome__tool_${index}`),
  );
}

/** 从装配结果中取出发现工具（不存在则断言失败） */
function getDiscovery(context: { tools: Tool[] }): Tool {
  const discovery = context.tools.find(
    (tool) => tool.name === "discover_mcp_tools",
  );
  expect(discovery).toBeDefined();
  return discovery as Tool;
}

describe("MCP 工具按需暴露", () => {
  it("MCP 工具数不超过阈值时全量下发，不装配发现工具", () => {
    const context = setupSkillContext({
      basePrompt: "测试",
      extraTools: makeMcpTools(MCP_INLINE_TOOL_LIMIT),
    });
    expect(
      context.advertisedTools.some(
        (tool) => tool.name === "discover_mcp_tools",
      ),
    ).toBe(false);
    expect(
      context.advertisedTools.filter((tool) => tool.name.startsWith("mcp__"))
        .length,
    ).toBe(MCP_INLINE_TOOL_LIMIT);
    expect(context.tools).toBe(context.advertisedTools);
  });

  it("MCP 工具数超过阈值时折叠为发现工具，执行侧仍持全量", () => {
    const total = MCP_INLINE_TOOL_LIMIT + 1;
    const context = setupSkillContext({
      basePrompt: "测试",
      extraTools: makeMcpTools(total),
    });
    expect(
      context.advertisedTools.filter((tool) => tool.name.startsWith("mcp__"))
        .length,
    ).toBe(0);
    expect(
      context.advertisedTools.some(
        (tool) => tool.name === "discover_mcp_tools",
      ),
    ).toBe(true);
    expect(context.tools.filter((tool) => tool.name.startsWith("mcp__")).length).toBe(
      total,
    );
    expect(context.systemPrompt).toMatch(/discover_mcp_tools/);
  });

  it("发现工具支持关键词与服务器过滤", async () => {
    const context = setupSkillContext({
      basePrompt: "测试",
      extraTools: [
        makeMcpTool("mcp__chrome__navigate", "chrome"),
        makeMcpTool("mcp__chrome__click", "chrome"),
        makeMcpTool("mcp__db__query", "db"),
        ...makeMcpTools(7),
      ],
    });
    const discovery = getDiscovery(context);
    const byQuery = await discovery.execute({ query: "navigate" });
    expect(byQuery.output).toMatch(/mcp__chrome__navigate/);
    expect(byQuery.output).not.toMatch(/mcp__db__query：/);
    const byServer = await discovery.execute({ server: "db" });
    expect(byServer.output).toMatch(/mcp__db__query/);
    expect(byServer.output).not.toMatch(/mcp__chrome__click/);
    const empty = await discovery.execute({ query: "不存在的工具" });
    expect(empty.output).toMatch(/未匹配到/);
  });

  it("激活后工具进入下发清单且幂等，未知名称给出提示", async () => {
    const context = setupSkillContext({
      basePrompt: "测试",
      extraTools: makeMcpTools(MCP_INLINE_TOOL_LIMIT + 1),
    });
    const discovery = getDiscovery(context);
    const target = "mcp__chrome__tool_0";
    const activated = await discovery.execute({ activate: [target] });
    expect(activated.output).toMatch(/已激活/);
    expect(activated.output).toMatch(/参数 schema/);
    expect(context.advertisedTools.some((tool) => tool.name === target)).toBe(
      true,
    );
    const before = context.advertisedTools.length;
    const again = await discovery.execute({ activate: [target] });
    expect(again.output).toMatch(/已处于激活状态/);
    expect(context.advertisedTools.length).toBe(before);
    const unknown = await discovery.execute({ activate: ["mcp__none__x"] });
    expect(unknown.output).toMatch(/未找到工具/);
  });

  it("未激活的 MCP 工具仍可被执行侧直接调用", async () => {
    const context = setupSkillContext({
      basePrompt: "测试",
      extraTools: makeMcpTools(MCP_INLINE_TOOL_LIMIT + 1),
    });
    const target = context.tools.find(
      (tool) => tool.name === "mcp__chrome__tool_3",
    );
    expect(target).toBeDefined();
    const result = await (target as Tool).execute({});
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/已执行/);
  });
});
