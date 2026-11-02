import type { Tool, ToolOutput } from "../types";

/** 单次抓取的请求级超时（毫秒）：需小于执行器 30s 兜底超时，留出转换与截断余量 */
const FETCH_TIMEOUT_MS = 25_000;

/** 最大重定向次数：逐跳校验目标地址，避免重定向绕过内网拦截 */
const MAX_REDIRECTS = 5;

/** 响应体读取上限（字节）：超出部分丢弃，避免超大页面撑爆内存 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Markdown 输出默认长度：控制单次回传模型的上下文开销 */
const DEFAULT_MAX_CHARS = 6_000;

/** Markdown 输出长度下限 / 上限：上限预留头部与提示信息，确保执行器 8KB 截断前完整回传 */
const MIN_MAX_CHARS = 500;
const MAX_MAX_CHARS = 7_500;

/** 需要跟随的重定向状态码 */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/** 常用于页面正文的 HTML 实体解码表（未命中的实体原样保留） */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  middot: "·",
  times: "×",
  laquo: "«",
  raquo: "»",
};

/**
 * 解码常见 HTML 实体与数字实体（十进制 / 十六进制）
 * @param {string} text - 含实体的文本
 * @returns {string} 解码后的文本
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-f]+|[a-z]+);/gi,
    (match, entity: string) => {
      if (entity.startsWith("#")) {
        const isHex = entity[1]?.toLowerCase() === "x";
        const code = parseInt(
          isHex ? entity.slice(2) : entity.slice(1),
          isHex ? 16 : 10,
        );
        if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
          return String.fromCodePoint(code);
        }
        return match;
      }
      return HTML_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

/**
 * 读取标签内的属性值（兼容单引号 / 双引号）
 * @param {string} tag - 标签原文
 * @param {string} name - 属性名
 * @returns {string} 属性值，缺失时为空串
 */
function getAttribute(tag: string, name: string): string {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag);
  return match?.[1] ?? "";
}

/**
 * 把相对地址解析为绝对地址；解析失败时保留原文
 * @param {string} href - 原始地址
 * @param {string} baseUrl - 页面地址
 * @returns {string} 绝对地址或原文
 */
function resolveUrl(href: string, baseUrl: string): string {
  const value = href.trim();
  if (!value || value.startsWith("#")) {
    return value;
  }
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

/**
 * 转换行内 HTML（链接、图片、强调、行内代码、换行），并剥离剩余标签
 * @param {string} fragment - 行内 HTML 片段
 * @param {string} baseUrl - 页面地址（用于解析相对链接）
 * @returns {string} Markdown 片段（实体尚未解码）
 */
function convertInline(fragment: string, baseUrl: string): string {
  const withImages = fragment.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = getAttribute(tag, "alt");
    const src = getAttribute(tag, "src");
    return src ? `![${alt}](${resolveUrl(src, baseUrl)})` : "";
  });
  const withLinks = withImages.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
    (_match, attrs: string, text: string) => {
      const href = getAttribute(attrs, "href");
      const label = convertInline(text, baseUrl).trim();
      return href ? `[${label}](${resolveUrl(href, baseUrl)})` : label;
    },
  );
  return withLinks
    .replace(
      /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,
      (_match, _tag: string, text: string) =>
        `**${convertInline(text, baseUrl).trim()}**`,
    )
    .replace(
      /<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi,
      (_match, _tag: string, text: string) =>
        `*${convertInline(text, baseUrl).trim()}*`,
    )
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, code: string) => {
      const raw = decodeHtmlEntities(code.replace(/<[^>]+>/g, ""));
      return raw ? `\`${raw.trim()}\`` : "";
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}

/**
 * 判断 HTML 是否像网页正文（用于缺失 Content-Type 时的兜底识别）
 * @param {string} body - 响应体
 * @param {string} contentType - 响应 Content-Type
 * @returns {boolean} 是否按 HTML 转换
 */
function looksLikeHtml(body: string, contentType: string): boolean {
  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    return true;
  }
  return /<(!doctype\s+html|html|head|body)/i.test(body.slice(0, 512));
}

/**
 * 把网页 HTML 转换为可读 Markdown：提取标题，保留标题层级、列表、链接、强调与代码块，剥离脚本与样式
 * @param {string} html - 网页 HTML
 * @param {string} pageUrl - 页面地址（解析相对链接）
 * @returns {string} Markdown 正文
 */
export function htmlToMarkdown(html: string, pageUrl: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, "")).trim()
    : "";

  // 先抽出代码块，避免后续空白压缩破坏缩进
  const codeBlocks: string[] = [];
  let working = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|svg|iframe|template|head|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    )
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
      const language =
        /class=["'][^"']*language-([\w+-]+)/i.exec(inner)?.[1] ?? "";
      const code = decodeHtmlEntities(inner.replace(/<[^>]+>/g, "")).replace(
        /^\n+|\n+$/g,
        "",
      );
      codeBlocks.push(`\`\`\`${language}\n${code}\n\`\`\``);
      return `\n\n@@TX_CODE_${codeBlocks.length - 1}@@\n\n`;
    });

  working = working
    .replace(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_match, level: string, inner: string) =>
        `\n\n${"#".repeat(Number(level))} ${convertInline(inner, pageUrl).trim()}\n\n`,
    )
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<blockquote[^>]*>/gi, "\n\n> ")
    .replace(/<\/blockquote>/gi, "\n\n")
    .replace(
      /<\/?(p|div|section|article|main|header|aside|table|thead|tbody|ul|ol|dl|figure)[^>]*>/gi,
      "\n\n",
    )
    .replace(/<tr[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<hr\b[^>]*>/gi, "\n\n---\n\n")
    .replace(/<br\s*\/?>/gi, "\n");

  const inline = decodeHtmlEntities(convertInline(working, pageUrl));
  const lines = inline
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd());
  let markdown = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  markdown = markdown.replace(
    /@@TX_CODE_(\d+)@@/g,
    (_match, index: string) => {
      const block = codeBlocks[Number(index)] ?? "";
      return block ? `\n\n${block}\n\n` : "";
    },
  );

  const finalBody = markdown.replace(/\n{3,}/g, "\n\n").trim();
  if (!title || finalBody.startsWith(`# ${title}`)) {
    return finalBody;
  }
  return finalBody ? `# ${title}\n\n${finalBody}` : `# ${title}`;
}

/**
 * 判断主机名是否属于内网 / 本机 / 链路本地地址（防 SSRF）
 * @param {string} hostname - URL 主机名
 * @returns {boolean} 是否禁止访问
 */
function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) {
    return true;
  }
  if (host === "localhost" || host === "::1" || host === "::") {
    return true;
  }
  // IPv6 链路本地（fe80::/10）与唯一本地地址（fc00::/7）
  if (/^fe[89ab][0-9a-f]:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host)) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) {
    return false;
  }
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return true;
  }
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

/**
 * 校验待抓取地址：仅允许公网 http/https，拒绝内网 / 本机与带凭据的 URL
 * @param {URL} url - 待校验地址
 * @returns {void}
 * @throws {Error} 地址不允许抓取时抛出
 */
function assertFetchableUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`仅支持 http/https 协议（收到 ${url.protocol}）`);
  }
  if (!url.hostname) {
    throw new Error("URL 缺少主机名");
  }
  if (url.username || url.password) {
    throw new Error("URL 不能包含用户名或密码");
  }
  if (isPrivateHostname(url.hostname)) {
    throw new Error(`禁止抓取内网或本机地址（${url.hostname}）`);
  }
}

/**
 * 抓取网页并逐跳跟随重定向（每一跳都重新校验地址，防止重定向绕过内网拦截）
 * @param {URL} url - 起始地址
 * @param {AbortSignal} signal - 超时 / 取消信号
 * @returns {Promise<{ response: Response; finalUrl: string }>} 最终响应与最终地址
 */
async function fetchWithRedirects(
  url: URL,
  signal: AbortSignal,
): Promise<{ response: Response; finalUrl: string }> {
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(current.href, {
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": "tx-cli-web-fetch (+https://github.com/tanyueran/tx-cli)",
        Accept: "text/html,application/xhtml+xml,text/plain,application/json",
      },
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: current.href };
    }
    const location = response.headers.get("location");
    try {
      await response.body?.cancel();
    } catch {
      // 释放重定向响应体失败不影响主流程
    }
    if (!location) {
      throw new Error(`重定向响应缺少 Location（HTTP ${response.status}）`);
    }
    if (redirects === MAX_REDIRECTS) {
      throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次`);
    }
    current = new URL(location, current);
    assertFetchableUrl(current);
  }
  throw new Error("重定向处理失败");
}

/**
 * 数值参数兜底：非有限数回退缺省，并钳制在指定区间
 * @param {unknown} value - 模型给出的参数值
 * @param {number} fallback - 缺省值
 * @param {number} min - 下限
 * @param {number} max - 上限
 * @returns {number} 钳制后的整数
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * 构造失败输出
 * @param {string} message - 错误说明
 * @returns {ToolOutput} ok=false 的工具输出
 */
function fail(message: string): ToolOutput {
  return { ok: false, output: message };
}

/**
 * 内置工具：抓取 URL 网页并转换为 Markdown
 * 仅支持公网 http/https，逐跳校验重定向目标；长页面可用 offset 续读
 */
export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "抓取指定 URL 的网页并转换为 Markdown 正文，用于读取 web_search 结果或已知链接的完整内容；" +
    "仅支持公网 http/https，禁止内网与本机地址；长页面可传 offset 续读",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "要抓取的网页地址（http 或 https）",
      },
      maxChars: {
        type: "number",
        description: `单次返回的最大字符数（${MIN_MAX_CHARS}-${MAX_MAX_CHARS}），缺省 ${DEFAULT_MAX_CHARS}`,
      },
      offset: {
        type: "number",
        description: "从 Markdown 正文的第几个字符开始返回，用于续读长页面，缺省 0",
      },
    },
    required: ["url"],
  },
  permission: {
    capabilities: ["net"],
    // 进程内只读抓取：read-only 档未命中规则时默认放行（口径对齐 web_search）
    readOnlySafe: true,
    /**
     * 生成规则键：以最终 URL 为细粒度主体（非法 URL 保留原文，便于用户配置规则）
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string} 形如 web_fetch(https://example.com) 的规则键
     */
    ruleKey(args: Record<string, unknown>): string {
      const raw = typeof args.url === "string" ? args.url.trim() : "";
      try {
        return `web_fetch(${new URL(raw).href})`;
      } catch {
        return `web_fetch(${raw})`;
      }
    },
  },
  /**
   * 抓取并转换网页：参数、地址、网络、内容类型错误均转为失败输出回传模型
   * @param {Record<string, unknown>} args - 模型给出的参数
   * @returns {Promise<ToolOutput>} Markdown 正文或失败说明
   */
  async execute(args: Record<string, unknown>): Promise<ToolOutput> {
    const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
    if (!rawUrl) {
      return fail("缺少必填参数 url（要抓取的网页地址）");
    }
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      return fail(`URL 格式无效：${rawUrl}`);
    }
    try {
      assertFetchableUrl(target);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    const maxChars = clampInt(
      args.maxChars,
      DEFAULT_MAX_CHARS,
      MIN_MAX_CHARS,
      MAX_MAX_CHARS,
    );
    const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    try {
      const { response, finalUrl } = await fetchWithRedirects(
        target,
        AbortSignal.timeout(FETCH_TIMEOUT_MS),
      );
      if (!response.ok) {
        const statusText = response.statusText ? ` ${response.statusText}` : "";
        return fail(
          `抓取失败：HTTP ${response.status}${statusText}（URL：${finalUrl}）`,
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      const isHtmlType = /text\/html|application\/xhtml\+xml/i.test(contentType);
      const isTextType =
        contentType === "" ||
        /text\/|application\/(json|xml|ld\+json)/i.test(contentType);
      if (!isHtmlType && !isTextType) {
        return fail(
          `不支持的内容类型：${contentType || "未知"}（仅支持 HTML / 文本 / JSON，URL：${finalUrl}）`,
        );
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      const bodyTruncated = bytes.byteLength > MAX_BODY_BYTES;
      const body = bytes.subarray(0, MAX_BODY_BYTES).toString("utf8");
      const markdown = looksLikeHtml(body, contentType)
        ? htmlToMarkdown(body, finalUrl)
        : body.trim();

      if (!markdown) {
        return { ok: true, output: `网页正文为空或无法提取内容（URL：${finalUrl}）` };
      }

      const slice = markdown.slice(offset, offset + maxChars);
      const end = offset + slice.length;
      const lines = [`来源：${finalUrl}`];
      if (bodyTruncated) {
        lines.push(`（响应体超过 ${MAX_BODY_BYTES / 1024 / 1024}MB，已截取前 ${MAX_BODY_BYTES / 1024 / 1024}MB）`);
      }
      if (offset > 0) {
        lines.push(`（续读：从第 ${offset} 字符开始）`);
      }
      lines.push("", slice);
      if (end < markdown.length) {
        lines.push(
          "",
          `（内容未读完：可传 offset=${end} 继续，全文共 ${markdown.length} 字符）`,
        );
      }
      return { ok: true, output: lines.join("\n") };
    } catch (err) {
      const message =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
          ? `请求超时（${FETCH_TIMEOUT_MS / 1000} 秒）`
          : err instanceof Error
            ? err.message
            : String(err);
      return fail(`网页抓取失败：${message}（URL：${target.href}）`);
    }
  },
};
