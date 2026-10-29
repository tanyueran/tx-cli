import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readGlobalConfig,
  updateConfigSection,
} from "../src/shared/user-config";

/** 配置文件所在临时目录 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tx-cli-user-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readUserConfig", () => {
  it("文件不存在时返回空对象且不产生警告", () => {
    const { configData, warnings } = readGlobalConfig(join(dir, "none.json"));

    expect(configData).toEqual({});
    expect(warnings).toEqual([]);
  });

  it("同一进程内同一路径只读一次磁盘，后续读取返回缓存内容", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { a: 1 } }));
    const first = readGlobalConfig(path);
    // 读取之后修改磁盘内容，缓存应不受影响
    writeFileSync(path, JSON.stringify({ mcpServers: { b: 2 } }));
    const second = readGlobalConfig(path);

    expect(first.configData).toEqual({ mcpServers: { a: 1 } });
    expect(second.configData).toEqual({ mcpServers: { a: 1 } });
  });

  it("JSON 损坏时返回空对象并告警，重复读取不再告警", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not valid json");
    const first = readGlobalConfig(path);
    const second = readGlobalConfig(path);

    expect(first.configData).toEqual({});
    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]).toContain("解析失败");
    expect(second.configData).toEqual({});
    expect(second.warnings).toEqual([]);
  });

  it("顶层不是对象时按空配置处理且不告警", () => {
    const path = join(dir, "array.json");
    writeFileSync(path, JSON.stringify(["a", "b"]));
    const { configData, warnings } = readGlobalConfig(path);

    expect(configData).toEqual({});
    expect(warnings).toEqual([]);
  });
});

describe("updateConfigSection", () => {
  it("只替换目标段，其余段原样保留", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { a: 1 }, extra: true }));

    updateConfigSection("llm", { apiKey: "sk" }, path);
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));

    expect(onDisk).toEqual({
      mcpServers: { a: 1 },
      extra: true,
      llm: { apiKey: "sk" },
    });
  });

  it("写盘后缓存同步刷新，后续读取立即可见新值", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { a: 1 } }));
    readGlobalConfig(path);

    updateConfigSection("llm", { apiKey: "sk" }, path);
    const { configData } = readGlobalConfig(path);

    expect(configData).toEqual({
      mcpServers: { a: 1 },
      llm: { apiKey: "sk" },
    });
  });

  it("目标文件不存在时直接创建并写入该段", () => {
    const path = join(dir, "fresh.json");

    updateConfigSection("llm", { apiKey: "sk" }, path);
    const { configData } = readGlobalConfig(path);

    expect(configData).toEqual({ llm: { apiKey: "sk" } });
  });
});
