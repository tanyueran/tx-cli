import { spawn, type ChildProcess } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLI_BIN = fileURLToPath(new URL("../bin/tx-cli", import.meta.url));
const EXPECTED_REPLY = "你好，世界！";

/** 子进程执行结果，保留完整输出用于失败诊断 */
interface CapturedProcessResult {
  /** 进程退出码；被信号终止时为 null */
  code: number | null;
  /** 终止进程的信号；正常退出时为 null */
  signal: NodeJS.Signals | null;
  /** 标准输出全文 */
  stdout: string;
  /** 标准错误全文 */
  stderr: string;
}

/** 异步子进程执行选项 */
interface RunProcessOptions {
  /** 子进程工作目录 */
  cwd: string;
  /** 子进程环境变量 */
  env: NodeJS.ProcessEnv;
  /** 看门狗超时时间（毫秒） */
  timeoutMs: number;
  /** 子进程创建后的同步回调，用于外部清理 */
  onSpawn?: (child: ChildProcess) => void;
  /** 进程 exit 事件回调，用于记录早退信息 */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/** 假服务捕获的单个 HTTP 请求 */
interface CapturedRequest {
  /** HTTP 方法 */
  method: string | undefined;
  /** 请求路径 */
  url: string | undefined;
  /** Authorization 请求头 */
  authorization: string | undefined;
  /** JSON 请求体 */
  body: unknown;
}

/**
 * 格式化子进程输出，统一补充空输出提示
 * @param {string} stdout - 标准输出全文
 * @param {string} stderr - 标准错误全文
 * @returns {string} 可直接放入断言消息的诊断文本
 */
function formatProcessOutput(stdout: string, stderr: string): string {
  return `stdout:\n${stdout || "<空>"}\nstderr:\n${stderr || "<空>"}`;
}

/**
 * 异步启动子进程并持续捕获输出，超时后发送 SIGKILL，避免阻塞本地 HTTP 服务
 * @param {string} command - 要执行的可执行文件
 * @param {string[]} args - 命令行参数
 * @param {RunProcessOptions} options - 工作目录、环境、超时及进程事件回调
 * @returns {Promise<CapturedProcessResult>} 进程关闭后的退出状态与完整输出
 */
function runCapturedProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<CapturedProcessResult> {
  return new Promise<CapturedProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    options.onSpawn?.(child);

    let stdout = "";
    let stderr = "";
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const watchdog = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `命令执行超过 ${options.timeoutMs}ms：${command} ${args.join(" ")}\n` +
            `最后退出信息：code=${String(exitCode)}, signal=${String(exitSignal)}\n` +
            formatProcessOutput(stdout, stderr),
        ),
      );
    }, options.timeoutMs);

    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      options.onExit?.(code, signal);
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      reject(
        new Error(
          `子进程启动或运行失败：${error.message}\n${formatProcessOutput(stdout, stderr)}`,
          { cause: error },
        ),
      );
    });
    child.once("close", (code, signal) => {
      clearTimeout(watchdog);
      if (settled) {
        return;
      }
      settled = true;
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * 构建真实 @tx-cli/cli 产物，供后续进程级测试执行
 * @returns {Promise<void>} 构建成功且退出码为 0 时完成
 */
async function buildCli(): Promise<void> {
  const result = await runCapturedProcess(
    "pnpm",
    ["--filter", "@tx-cli/cli", "build"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      timeoutMs: 180_000,
    },
  );

  expect(
    result.code,
    `CLI 构建失败，signal=${String(result.signal)}\n${formatProcessOutput(result.stdout, result.stderr)}`,
  ).toBe(0);
}

/**
 * 创建隔离的 CLI 环境，移除常见代理并关闭终端颜色
 * @param {string} home - 临时用户主目录
 * @returns {NodeJS.ProcessEnv} 不继承代理设置的子进程环境
 */
function createCliEnvironment(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    delete env[name];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    NO_PROXY: "127.0.0.1",
    no_proxy: "127.0.0.1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
}

/**
 * 读取并解析单个请求的 JSON 请求体
 * @param {IncomingMessage} request - 本地服务收到的 HTTP 请求
 * @returns {Promise<unknown>} 解析后的 JSON 数据
 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return JSON.parse(body) as unknown;
}

/**
 * 按 SSE 格式写入一个带事件名的 Responses 事件
 * @param {ServerResponse} response - 当前 HTTP 响应
 * @param {string} eventName - SSE 事件名
 * @param {Record<string, unknown>} data - 事件 JSON 数据
 * @returns {void}
 */
function writeSseEvent(
  response: ServerResponse,
  eventName: string,
  data: Record<string, unknown>,
): void {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * 创建仅用于测试的 OpenAI Responses 假服务，并记录请求与服务端错误
 * @param {CapturedRequest[]} receivedRequests - 请求捕获数组
 * @param {string[]} serverErrors - 服务端异常诊断数组
 * @returns {Server} 尚未调用 listen 的 HTTP 服务
 */
function createFakeResponsesServer(
  receivedRequests: CapturedRequest[],
  serverErrors: string[],
): Server {
  /**
   * 校验传输层请求并返回包含两段正文、用量及结束标记的合法 SSE
   * @param {IncomingMessage} request - 当前 HTTP 请求
   * @param {ServerResponse} response - 当前 HTTP 响应
   * @returns {Promise<void>} 请求处理与响应写入完成
   */
  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const body = await readJsonBody(request);
      receivedRequests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });

      if (
        request.method !== "POST" ||
        request.url !== "/v1/responses" ||
        request.headers.authorization !== "Bearer sk-test"
      ) {
        response.writeHead(400, {
          "content-type": "application/json; charset=utf-8",
        });
        response.end(
          JSON.stringify({
            error: { message: "请求方法、路径或认证头不符合预期" },
          }),
        );
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      writeSseEvent(response, "response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: "msg_test",
        output_index: 0,
        content_index: 0,
        delta: "你好，",
        sequence_number: 0,
      });
      writeSseEvent(response, "response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: "msg_test",
        output_index: 0,
        content_index: 0,
        delta: "世界！",
        sequence_number: 1,
      });
      writeSseEvent(response, "response.completed", {
        type: "response.completed",
        sequence_number: 2,
        response: {
          id: "resp_test",
          object: "response",
          created_at: 1_700_000_000,
          status: "completed",
          model: "fake",
          output: [
            {
              id: "msg_test",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: EXPECTED_REPLY,
                  annotations: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 6,
            total_tokens: 18,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      });
      response.end("data: [DONE]\n\n");
    } catch (error) {
      serverErrors.push(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      if (response.writableEnded) {
        return;
      }
      if (!response.headersSent) {
        response.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
        });
      }
      response.end(
        JSON.stringify({ error: { message: "假 Responses 服务处理失败" } }),
      );
    }
  }

  return createServer(handleRequest);
}

/**
 * 仅在 IPv4 回环地址的随机空闲端口启动 HTTP 服务
 * @param {Server} server - 待启动的 HTTP 服务
 * @returns {Promise<number>} 实际监听的本地端口
 */
function listenOnLoopback(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    /**
     * 监听成功后解析随机端口，并移除启动阶段的错误监听
     * @returns {void}
     */
    function onListening(): void {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("本地假服务未取得有效的 TCP 监听地址"));
        return;
      }
      resolve(address.port);
    }

    server.once("error", reject);
    server.listen(0, "127.0.0.1", onListening);
  });
}

/**
 * 终止仍在运行的子进程，避免超时或断言失败后残留 CLI
 * @param {ChildProcess | undefined} child - 待清理的子进程
 * @returns {void}
 */
function stopChild(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGKILL");
}

/**
 * 关闭 HTTP 服务及其全部连接，避免 keep-alive 连接阻塞测试退出
 * @param {Server} server - 待关闭的本地 HTTP 服务
 * @returns {Promise<void>} 服务关闭完成
 */
function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    server.closeAllConnections();
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    /**
     * 接收服务关闭结果并结束清理等待
     * @param {Error | undefined} error - 关闭失败时的错误
     * @returns {void}
     */
    function onClosed(error?: Error): void {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }

    server.close(onClosed);
    server.closeAllConnections();
  });
}

/**
 * 通过真实构建 CLI 与本地假 Responses 服务验证 chat 单次问题完整链路
 * @returns {Promise<void>} 全部进程、协议与输出断言完成
 */
async function testChatSingleQuestion(): Promise<void> {
  const receivedRequests: CapturedRequest[] = [];
  const serverErrors: string[] = [];
  let tempRoot: string | undefined;
  let server: Server | undefined;
  let child: ChildProcess | undefined;
  let earlyExit = "未发生";

  try {
    tempRoot = mkdtempSync(join(tmpdir(), "tx-cli-chat-process-"));
    const cwd = join(tempRoot, "cwd");
    const home = join(tempRoot, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });

    server = createFakeResponsesServer(receivedRequests, serverErrors);
    const port = await listenOnLoopback(server);
    const configDirectory = join(cwd, ".tx-cli");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(
      join(configDirectory, "config.json"),
      JSON.stringify({
        llm: {
          apiKey: "sk-test",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "fake",
          thinkingStyle: "none",
        },
      }),
    );

    let result: CapturedProcessResult;
    try {
      result = await runCapturedProcess(
        process.execPath,
        [CLI_BIN, "chat", "请回答"],
        {
          cwd,
          env: createCliEnvironment(home),
          timeoutMs: 20_000,
          onSpawn: (spawnedChild) => {
            child = spawnedChild;
          },
          onExit: (code, signal) => {
            if (receivedRequests.length === 0) {
              earlyExit = `CLI 在请求到达前退出：code=${String(code)}, signal=${String(signal)}`;
            }
          },
        },
      );
    } catch (error) {
      const processError =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      throw new Error(
        `chat 进程执行失败\n${processError}\n早退信息：${earlyExit}\n` +
          `服务端错误：${serverErrors.join("\n") || "无"}\n` +
          `已捕获请求：${JSON.stringify(receivedRequests)}`,
        { cause: error },
      );
    }

    const diagnostic = [
      `早退信息：${earlyExit}`,
      `服务端错误：${serverErrors.join("\n") || "无"}`,
      `已捕获请求：${JSON.stringify(receivedRequests)}`,
      formatProcessOutput(result.stdout, result.stderr),
    ].join("\n");

    expect(result.code, diagnostic).toBe(0);
    expect(receivedRequests, diagnostic).toHaveLength(1);
    expect(serverErrors, diagnostic).toEqual([]);

    const request = receivedRequests[0];
    expect(request.method, diagnostic).toBe("POST");
    expect(request.url, diagnostic).toBe("/v1/responses");
    expect(request.authorization, diagnostic).toBe("Bearer sk-test");
    expect(request.body, diagnostic).toMatchObject({
      model: "fake",
      input: [{ role: "user", content: "请回答" }],
      store: false,
      stream: true,
    });
    expect(result.stdout, diagnostic).toContain(EXPECTED_REPLY);
  } finally {
    try {
      stopChild(child);
      if (server) {
        await closeServer(server);
      }
    } finally {
      if (tempRoot) {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  }
}

beforeAll(buildCli, 190_000);

it(
  "chat 单次问题经真实构建 CLI 与本地 Responses 流式服务完整往返",
  testChatSingleQuestion,
  30_000,
);
