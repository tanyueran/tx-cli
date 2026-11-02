import { afterEach, describe, expect, it, vi } from "vitest";
import {
  htmlToMarkdown,
  webFetchTool,
} from "../src/core/tools/builtin/web-fetch";

/**
 * 构造模拟响应
 * @param {object} options - 状态码、内容类型、正文与附加响应头
 * @returns {Response} 模拟的 fetch Response
 */
function mockResponse(options: {
  body?: string;
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
}): Response {
  const {
    body = "",
    status = 200,
    contentType = "text/html; charset=utf-8",
    headers = {},
  } = options;
  const bytes = new TextEncoder().encode(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "",
    headers: new Headers({ "content-type": contentType, ...headers }),
    url: "",
    body: null,
    arrayBuffer: async () => bytes.slice().buffer,
  } as unknown as Response;
}

/**
 * 构造重定向响应
 * @param {string} location - 重定向目标
 * @returns {Response} 302 模拟响应
 */
function mockRedirect(location: string): Response {
  return mockResponse({
    status: 302,
    headers: { location },
  });
}

describe("htmlToMarkdown", () => {
  it("保留标题、列表、链接、强调与代码块并解码实体", () => {
    const markdown = htmlToMarkdown(
      `
      <html>
        <head>
          <title>示例标题</title>
          <style>body { color: red }</style>
        </head>
        <body>
          <h1>正文标题</h1>
          <p>这是 <strong>重点</strong> 与 <a href="/doc">链接</a>，还有 &amp; 符号。</p>
          <ul><li>第一项</li><li>第二项</li></ul>
          <pre><code class="language-js">const a = 1;</code></pre>
        </body>
      </html>
      `,
      "https://example.com/page",
    );

    expect(markdown).toContain("# 示例标题");
    expect(markdown).toContain("# 正文标题");
    expect(markdown).toContain("**重点**");
    expect(markdown).toContain("[链接](https://example.com/doc)");
    expect(markdown).toContain("& 符号");
    expect(markdown).toContain("- 第一项");
    expect(markdown).toContain("```js");
    expect(markdown).toContain("const a = 1;");
    expect(markdown).not.toContain("color: red");
  });

  it("纯文本内容不注入标题", () => {
    expect(htmlToMarkdown("hello world", "https://example.com")).toBe(
      "hello world",
    );
  });
});

describe("web_fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("抓取 HTML 页面并回传来源与 Markdown", async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse({
        body: "<html><body><h1>Hello</h1><p>World</p></body></html>",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await webFetchTool.execute({
      url: "https://example.com/page",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("来源：https://example.com/page");
    expect(result.output).toContain("# Hello");
    expect(result.output).toContain("World");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/page",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("纯文本按原文返回", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        mockResponse({ body: "plain text", contentType: "text/plain" }),
      ),
    );

    const result = await webFetchTool.execute({
      url: "https://example.com/a.txt",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("plain text");
  });

  it("拒绝非 http/https 协议", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await webFetchTool.execute({ url: "ftp://example.com/file" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("仅支持 http/https");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("拒绝内网与本机地址", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const url of [
      "http://127.0.0.1/admin",
      "http://192.168.1.1/",
      "http://localhost:8080/",
    ]) {
      const result = await webFetchTool.execute({ url });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("禁止抓取内网或本机地址");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("重定向到内网地址时中止且不发起第二跳请求", async () => {
    const fetchMock = vi.fn(async () => mockRedirect("http://127.0.0.1/x"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await webFetchTool.execute({
      url: "https://example.com/page",
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("禁止抓取内网或本机地址");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("HTTP 错误转为失败输出", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse({ status: 404, body: "not found" })),
    );

    const result = await webFetchTool.execute({
      url: "https://example.com/missing",
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("HTTP 404");
  });

  it("不支持的内容类型直接拒绝", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        mockResponse({ body: "%PDF", contentType: "application/pdf" }),
      ),
    );

    const result = await webFetchTool.execute({
      url: "https://example.com/file.pdf",
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("不支持的内容类型");
  });

  it("长正文按 maxChars 截断并提示 offset 续读", async () => {
    const body = "a".repeat(7000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse({ body, contentType: "text/plain" })),
    );

    const result = await webFetchTool.execute({
      url: "https://example.com/long",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("offset=6000");
    expect(result.output).toContain("全文共 7000 字符");
  });

  it("offset 续读时标注起始位置", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        mockResponse({ body: "a".repeat(7000), contentType: "text/plain" }),
      ),
    );

    const result = await webFetchTool.execute({
      url: "https://example.com/long",
      offset: 6000,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("续读：从第 6000 字符开始");
  });
});
