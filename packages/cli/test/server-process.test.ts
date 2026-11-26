import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_BIN = fileURLToPath(new URL("../bin/tx-cli", import.meta.url));
const HOST = "127.0.0.1";
const READY_TEXT = "本地开发服务器已启动";
const STARTUP_TIMEOUT = 10_000;
const REQUEST_TIMEOUT = 5_000;
const EXIT_TIMEOUT = 5_000;
const CLEANUP_TIMEOUT = 5_000;

interface CloseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface CliSession {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  closed: Promise<CloseResult>;
}

let tempRoot: string;
let home: string;
let configHome: string;
let session: CliSession | undefined;

/**
 * 为 Promise 增加超时限制，并在结束后清理定时器
 * @param {Promise<T>} promise - 要等待的 Promise
 * @param {number} timeoutMs - 超时毫秒数
 * @param {string} message - 超时错误信息
 * @returns {Promise<T>} 原 Promise 的结果
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * 创建隔离用户目录的子进程环境
 * @param {string} homeDirectory - 子进程使用的用户主目录
 * @param {string} configDirectory - 子进程使用的 XDG 配置目录
 * @returns {NodeJS.ProcessEnv} 隔离后的子进程环境变量
 */
function createIsolatedEnvironment(
  homeDirectory: string,
  configDirectory: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    XDG_CONFIG_HOME: configDirectory,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
}

/**
 * 在指定地址监听临时网络服务器
 * @param {HttpServer} server - 要启动的网络服务器
 * @param {number} port - 要监听的端口，0 表示由系统分配
 * @param {string} host - 要监听的主机地址
 * @returns {Promise<void>} 监听成功后完成
 */
async function listenOn(
  server: HttpServer,
  port: number,
  host: string,
): Promise<void> {
  const listening = new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  await withTimeout(
    listening,
    REQUEST_TIMEOUT,
    `等待 ${host}:${port} 监听超时`,
  );
}

/**
 * 关闭网络服务器及其全部连接，并等待关闭完成
 * @param {HttpServer} server - 要关闭的网络服务器
 * @param {number} timeoutMs - 关闭超时毫秒数
 * @returns {Promise<void>} 服务器关闭后完成
 */
async function closeHttpServer(
  server: HttpServer,
  timeoutMs: number,
): Promise<void> {
  if (!server.listening) {
    return;
  }
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    server.closeAllConnections();
  });
  await withTimeout(closed, timeoutMs, "关闭临时网络服务器超时");
}

/**
 * 获取一个由系统分配的可用端口，并在返回前释放临时监听器
 * @param {string} host - 用于探测可用端口的主机地址
 * @returns {Promise<number>} 可交给 CLI 使用的端口号
 */
async function getAvailablePort(host: string): Promise<number> {
  const server = createServer();
  try {
    await listenOn(server, 0, host);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("无法获取临时监听器的 TCP 端口");
    }
    return address.port;
  } finally {
    await closeHttpServer(server, CLEANUP_TIMEOUT);
  }
}

/**
 * 验证指定地址已经可以重新监听，并在验证后释放监听器
 * @param {number} port - 要验证已释放的端口
 * @param {string} host - 要验证的主机地址
 * @returns {Promise<void>} 地址可重新监听且临时服务器关闭后完成
 */
async function verifyPortReleased(port: number, host: string): Promise<void> {
  const server = createServer();
  try {
    await listenOn(server, port, host);
  } finally {
    await closeHttpServer(server, CLEANUP_TIMEOUT);
  }
}

/**
 * 启动真实构建的静态服务器 CLI，并持续收集输出与 close 事件
 * @param {number} port - CLI 要监听的端口
 * @param {string} directory - CLI 提供静态文件的目录
 * @returns {CliSession} 包含子进程、输出和关闭 Promise 的会话
 */
function spawnServer(port: number, directory: string): CliSession {
  const child = spawn(
    process.execPath,
    [
      CLI_BIN,
      "server",
      "-p",
      String(port),
      "-H",
      HOST,
      "-d",
      directory,
    ],
    {
      cwd: tempRoot,
      env: createIsolatedEnvironment(home, configHome),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let resolveClosed!: (result: CloseResult) => void;
  const closed = new Promise<CloseResult>((resolve) => {
    resolveClosed = resolve;
  });
  const currentSession: CliSession = {
    child,
    stdout: "",
    stderr: "",
    closed,
  };

  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    currentSession.stdout += chunk;
  });
  child.stderr!.on("data", (chunk: string) => {
    currentSession.stderr += chunk;
  });
  child.once("close", (code, signal) => {
    resolveClosed({ code, signal });
  });
  return currentSession;
}

/**
 * 等待 CLI 标准输出出现服务器就绪文本
 * @param {CliSession} currentSession - 正在运行的 CLI 会话
 * @param {number} timeoutMs - 启动超时毫秒数
 * @returns {Promise<void>} 检测到就绪文本后完成
 */
async function waitForServerReady(
  currentSession: CliSession,
  timeoutMs: number,
): Promise<void> {
  const { child } = currentSession;
  const ready = new Promise<void>((resolve, reject) => {
    const checkReady = () => {
      if (currentSession.stdout.includes(READY_TEXT)) {
        resolve();
      }
    };
    child.stdout!.on("data", checkReady);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      reject(
        new Error(
          `CLI 在就绪前关闭：code=${code}，signal=${signal}\n` +
            `标准输出：\n${currentSession.stdout}\n` +
            `标准错误：\n${currentSession.stderr}`,
        ),
      );
    });
    checkReady();
  });
  await withTimeout(
    ready,
    timeoutMs,
    `等待服务器就绪超时\n标准输出：\n${currentSession.stdout}\n` +
      `标准错误：\n${currentSession.stderr}`,
  );
}

/**
 * 等待 CLI 的 close 事件，确保进程和标准流均已结束
 * @param {CliSession} currentSession - 正在运行的 CLI 会话
 * @param {number} timeoutMs - 退出超时毫秒数
 * @returns {Promise<CloseResult>} 进程关闭时的退出码与信号
 */
async function waitForClose(
  currentSession: CliSession,
  timeoutMs: number,
): Promise<CloseResult> {
  return withTimeout(
    currentSession.closed,
    timeoutMs,
    `等待 CLI 退出超时\n标准输出：\n${currentSession.stdout}\n` +
      `标准错误：\n${currentSession.stderr}`,
  );
}

/**
 * 在测试清理阶段强制终止仍运行的 CLI，并等待 close 事件
 * @param {CliSession} currentSession - 需要清理的 CLI 会话
 * @param {number} timeoutMs - 清理超时毫秒数
 * @returns {Promise<void>} 进程关闭后完成
 */
async function forceStopServer(
  currentSession: CliSession,
  timeoutMs: number,
): Promise<void> {
  const { child } = currentSession;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await waitForClose(currentSession, timeoutMs);
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "tx-cli-server-process-"));
  home = join(tempRoot, "home");
  configHome = join(tempRoot, "xdg-config");
  mkdirSync(home, { recursive: true });
  mkdirSync(configHome, { recursive: true });
});

afterEach(async () => {
  try {
    if (session) {
      await forceStopServer(session, CLEANUP_TIMEOUT);
    }
  } finally {
    session = undefined;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("真实构建产物的 server 进程行为", () => {
  it("提供静态文件，并在 SIGINT 后正常退出且释放端口", async () => {
    const directory = join(tempRoot, "site");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "hello.txt"), "hello tx-cli");
    const port = await getAvailablePort(HOST);
    session = spawnServer(port, directory);

    await waitForServerReady(session, STARTUP_TIMEOUT);
    const response = await fetch(`http://${HOST}:${port}/hello.txt`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello tx-cli");

    session.child.kill("SIGINT");
    const closeResult = await waitForClose(session, EXIT_TIMEOUT);
    expect(
      closeResult.code,
      `标准输出：\n${session.stdout}\n标准错误：\n${session.stderr}`,
    ).toBe(0);
    expect(closeResult.signal).toBeNull();
    expect(session.stdout).toContain("服务器已停止");

    await verifyPortReleased(port, HOST);
  }, 30_000);
});
