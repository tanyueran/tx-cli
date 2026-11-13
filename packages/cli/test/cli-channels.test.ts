import { describe, it, expect, vi, afterEach } from "vitest";
import { CliOutputChannel } from "../src/channels/cli-output";

/** 捕获 console.log 的输出行 */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CliOutputChannel.toolCall", () => {
  it("无自定义渲染时打印工具名与原始参数", () => {
    const { lines, restore } = captureLogs();
    try {
      const channel = new CliOutputChannel();
      channel.toolCall({
        name: "read_file",
        arguments: '{"path":"a.ts"}',
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("read_file");
      expect(lines[0]).toContain('{"path":"a.ts"}');
    } finally {
      restore();
    }
  });

  it("带自定义渲染时分两行输出", () => {
    const { lines, restore } = captureLogs();
    try {
      const channel = new CliOutputChannel();
      channel.toolCall({
        name: "write_todos",
        arguments: "{}",
        renderedCall: "清单视图",
      });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("write_todos");
      expect(lines[1]).toContain("清单视图");
    } finally {
      restore();
    }
  });
});

describe("CliOutputChannel.usage", () => {
  it("用量展示输出表格", () => {
    const { lines, restore } = captureLogs();
    try {
      const channel = new CliOutputChannel();
      channel.usage({
        rows: [
          {
            label: "本次",
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 120,
              cachedTokens: 0,
              reasoningTokens: 0,
            },
            emphasis: true,
          },
        ],
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("本次");
      expect(lines[0]).toContain("100");
      expect(lines[0]).toContain("20");
    } finally {
      restore();
    }
  });
});

describe("CliOutputChannel 流式状态", () => {
  it("正文增量后 ensureNewline 结束当前行", () => {
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const channel = new CliOutputChannel();
      channel.streamToken("答");
      channel.ensureNewline();
      expect(writeSpy.mock.calls.flat().join("")).toContain("答");
      expect(writeSpy.mock.calls.flat().join("")).toContain("\n");
    } finally {
      writeSpy.mockRestore();
    }
  });
});
