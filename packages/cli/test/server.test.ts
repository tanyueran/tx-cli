import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type http from "node:http";
import { startServer } from "../src/services/server";

/** 记录测试期间启动的服务器，用例结束后统一关闭 */
const servers: http.Server[] = [];

/**
 * 启动静态服务器并登记到清理列表
 * @param {Parameters<typeof startServer>[0]} options - 服务器配置项
 * @returns {Promise<{ server: http.Server; url: string }>} server 实例与访问地址
 */
async function launch(
  options: Parameters<typeof startServer>[0],
): Promise<{ server: http.Server; url: string }> {
  const result = await startServer(options);
  servers.push(result.server);
  return result;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          // 关闭空闲的 keep-alive 连接，避免 close 一直等待
          server.closeAllConnections();
        }),
    ),
  );
});

describe("startServer", () => {
  it("启动成功：返回访问地址，静态文件可访问并携带自定义响应头", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tx-cli-server-"));
    try {
      writeFileSync(join(dir, "hello.txt"), "hello tx-cli");
      // port=0 由系统分配空闲端口，避免与本地服务冲突
      const { server, url } = await launch({
        port: 0,
        host: "127.0.0.1",
        directory: dir,
        header: { "X-Test-Header": "tx-cli" },
      });

      const address = server.address();
      expect(address).not.toBeNull();
      expect(url).toBe("http://127.0.0.1:0");

      const port = (address as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/hello.txt`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("hello tx-cli");
      expect(response.headers.get("x-test-header")).toBe("tx-cli");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("路径不存在时返回 404 Not Found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tx-cli-server-"));
    try {
      const { server } = await launch({
        port: 0,
        host: "127.0.0.1",
        directory: dir,
      });
      const port = (server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/missing.txt`);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("监听失败（端口被占用）时 reject，且不泄漏服务器实例", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tx-cli-server-"));
    try {
      const { server } = await launch({
        port: 0,
        host: "127.0.0.1",
        directory: dir,
      });
      const port = (server.address() as { port: number }).port;

      await expect(
        startServer({ port, host: "127.0.0.1", directory: dir }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
