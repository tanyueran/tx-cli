import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpServers } from "../src/core/mcp";

/** 配置文件所在临时目录 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tx-cli-mcp-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TX_TEST_VAR;
});

/**
 * 写入配置文件并返回其路径
 * @param {unknown} content - 配置内容（将被序列化为 JSON）
 * @returns {string} 配置文件绝对路径
 */
function writeConfig(content: unknown): string {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe("loadMcpServers", () => {
  it("配置文件不存在时返回空结果且无警告", () => {
    const { servers, warnings } = loadMcpServers(join(dir, "none.json"));

    expect(servers.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("无 mcpServers 段时返回空结果且无警告", () => {
    const { servers, warnings } = loadMcpServers(writeConfig({ llm: {} }));

    expect(servers.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("解析显式与隐式 type 的 stdio/http 配置（兼容 Claude Desktop 格式）", () => {
    const path = writeConfig({
      mcpServers: {
        explicit: { type: "stdio", command: "npx", args: ["-y", "srv"] },
        implicit: { command: "node", args: ["server.js"] },
        remote: { type: "http", url: "https://example.com/mcp" },
        implicitRemote: { url: "https://example.com/other" },
      },
    });

    const { servers, warnings } = loadMcpServers(path);

    expect(warnings).toEqual([]);
    expect(servers.get("explicit")).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "srv"],
    });
    expect(servers.get("implicit")).toEqual({
      type: "stdio",
      command: "node",
      args: ["server.js"],
    });
    expect(servers.get("remote")).toEqual({
      type: "http",
      url: "https://example.com/mcp",
    });
    expect(servers.get("implicitRemote")).toEqual({
      type: "http",
      url: "https://example.com/other",
    });
  });

  it("展开字符串值中的 ${VAR} 引用，未定义变量展开为空串", () => {
    process.env.TX_TEST_VAR = "hello";
    const path = writeConfig({
      mcpServers: {
        stdio: {
          type: "stdio",
          command: "${TX_TEST_VAR}-run",
          args: ["--token", "${TX_TEST_VAR}", "--missing", "${TX_MISSING_VAR}"],
          env: { KEY: "${TX_TEST_VAR}" },
        },
        http: {
          type: "http",
          url: "https://${TX_TEST_VAR}.example.com/mcp",
          headers: { Authorization: "Bearer ${TX_TEST_VAR}" },
        },
      },
    });

    const { servers, warnings } = loadMcpServers(path);

    expect(warnings).toEqual([]);
    expect(servers.get("stdio")).toEqual({
      type: "stdio",
      command: "hello-run",
      args: ["--token", "hello", "--missing", ""],
      env: { KEY: "hello" },
    });
    expect(servers.get("http")).toEqual({
      type: "http",
      url: "https://hello.example.com/mcp",
      headers: { Authorization: "Bearer hello" },
    });
  });

  it("JSON 损坏时告警并忽略全部服务器", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not valid json");
    const { servers, warnings } = loadMcpServers(path);

    expect(servers.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("解析失败");
  });

  it("mcpServers 不是对象时告警并忽略全部服务器", () => {
    const { servers, warnings } = loadMcpServers(
      writeConfig({ mcpServers: ["a", "b"] }),
    );

    expect(servers.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("mcpServers");
  });

  it("非法项跳过并告警，不影响其他合法服务器", () => {
    const path = writeConfig({
      mcpServers: {
        notObject: "just-a-string",
        badType: { type: "websocket", url: "https://example.com" },
        noCommand: { type: "stdio" },
        emptyCommand: { type: "stdio", command: "  " },
        badArgs: { type: "stdio", command: "npx", args: [1, 2] },
        badEnv: { type: "stdio", command: "npx", env: { K: 1 } },
        noUrl: { type: "http" },
        badHeaders: { type: "http", url: "https://example.com", headers: 5 },
        good: { type: "stdio", command: "node" },
      },
    });

    const { servers, warnings } = loadMcpServers(path);

    expect(servers.size).toBe(1);
    expect(servers.get("good")).toEqual({ type: "stdio", command: "node" });
    expect(warnings).toHaveLength(8);
  });

  it("空字符串服务器名跳过并告警", () => {
    const path = writeConfig({
      mcpServers: {
        "": { type: "stdio", command: "node" },
      },
    });

    const { servers, warnings } = loadMcpServers(path);

    expect(servers.size).toBe(0);
    expect(warnings.some((w) => w.includes("服务器名不能为空"))).toBe(true);
  });

  it("项目与全局按服务器名合并：同名以项目为准并告警", () => {
    const globalPath = writeConfig({
      mcpServers: {
        shared: { type: "stdio", command: "global-cmd" },
        onlyGlobal: { type: "stdio", command: "node" },
      },
    });
    const projectPath = join(dir, "project-config.json");
    writeFileSync(
      projectPath,
      JSON.stringify({
        mcpServers: {
          shared: { type: "http", url: "https://project.example.com/mcp" },
          onlyProject: { type: "stdio", command: "node" },
        },
      }),
    );

    const { servers, warnings } = loadMcpServers(globalPath, projectPath);

    expect(servers.size).toBe(3);
    // 同名服务器：项目配置覆盖全局
    expect(servers.get("shared")).toEqual({
      type: "http",
      url: "https://project.example.com/mcp",
    });
    // 仅全局 / 仅项目定义的服务器均保留
    expect(servers.get("onlyGlobal")).toEqual({ type: "stdio", command: "node" });
    expect(servers.get("onlyProject")).toEqual({ type: "stdio", command: "node" });
    expect(warnings.some((w) => w.includes("已加载项目配置"))).toBe(true);
    expect(
      warnings.some((w) => w.includes("重复定义") && w.includes("shared")),
    ).toBe(true);
  });

  it("项目配置文件缺失时跳过项目层且无项目加载告警", () => {
    const globalPath = writeConfig({
      mcpServers: { local: { type: "stdio", command: "node" } },
    });

    const { servers, warnings } = loadMcpServers(
      globalPath,
      join(dir, "missing.json"),
    );

    expect(servers.size).toBe(1);
    expect(warnings).toEqual([]);
  });
});
