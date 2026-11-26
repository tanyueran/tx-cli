/**
 * 工具注册表：全 CLI 已知工具的名称常量与「消费者 → 工具裁剪集合」的唯一维护点。
 *
 * 消费者 → 可用工具总览（装配逻辑分别在 runtime/session-assembly.ts 与 conversation 层
 * sub-agent.ts，本文件集中维护其中跨模块引用的名称常量与裁剪集合）：
 * - chat 命令：内置工具（剔除 WRITE_TOOL_NAMES）+ load_skill；固定不装配 bash、MCP、
 *   write_todos 与 delegate_task（只读问答）
 * - agent 命令：内置工具全量 + load_skill + bash（跟随沙箱档位）+ write_todos +
 *   MCP 折叠 + delegate_task + task_status + task_stop
 * - 子 Agent（delegate_task 派生）：继承所在会话的工具，剔除 SUB_AGENT_EXCLUDED_TOOL_NAMES
 *
 * 工具定义位置索引：只有「可零上下文静态构造、随版本无条件装配」的工具才放 builtin/
 * （即 builtinTools 静态清单），其余工具是需要运行时上下文的工厂、按条件装配，
 * 跟随各自的能力域放置，避免底层 tools 反向依赖上层：
 * - builtin/*.ts —— 静态清单工具（read_file、list_dir、glob、grep、web_search、
 *   web_fetch、write_file、edit_file；bash 为工厂但定义在本域）
 * - skills/loader-tool.ts —— load_skill（需 SkillCatalog，skills 域的模型接口）
 * - mcp/discovery-tool.ts —— discover_mcp_tools（MCP 折叠机制的组成部分）
 * - conversation/sub-agent/attach.ts —— 子 Agent 执行核（runner）与会话装配
 * - conversation/sub-agent/dispatcher.ts —— delegate_task /
 *   task_status / task_stop（子 Agent 调度器：同步/后台分流与节点注册表）
 *
 * 本文件只登记名称常量与裁剪集合，不登记工具实例（实例由各定义模块与装配层持有），
 * 因此任何模块都可以安全引用本文件而不形成循环依赖；
 * 新增工具的步骤：在此登记名称常量 → 对应定义模块引用该常量 → 按需加入下方消费者集合。
 */

// ---------------------------------------------------------------------------
// 内置工具名（定义见 builtin/ 各文件）
// ---------------------------------------------------------------------------

/** 读取文本文件（read_file） */
export const READ_FILE_TOOL_NAME = "read_file";
/** 列出目录内容（list_dir，单层不递归） */
export const LIST_DIR_TOOL_NAME = "list_dir";
/** 按 glob 模式查找文件（glob） */
export const GLOB_TOOL_NAME = "glob";
/** 按正则搜索文件内容（grep） */
export const GREP_TOOL_NAME = "grep";
/** 搜索互联网（web_search） */
export const WEB_SEARCH_TOOL_NAME = "web_search";
/** 抓取网页转 Markdown（web_fetch） */
export const WEB_FETCH_TOOL_NAME = "web_fetch";
/** 创建或覆盖文本文件（write_file） */
export const WRITE_FILE_TOOL_NAME = "write_file";
/** 精确字符串替换编辑（edit_file） */
export const EDIT_FILE_TOOL_NAME = "edit_file";
/** 执行 bash 命令（bash，不在 builtinTools 静态清单中，由会话装配层按档位拼入） */
export const BASH_TOOL_NAME = "bash";

// ---------------------------------------------------------------------------
// 跨层工具名
// ---------------------------------------------------------------------------

/** 加载技能手册（load_skill，定义见 skills/loader-tool.ts） */
export const LOAD_SKILL_TOOL_NAME = "load_skill";
/** MCP 工具目录检索与激活（discover_mcp_tools，折叠模式，定义见 mcp/discovery-tool.ts） */
export const MCP_DISCOVERY_TOOL_NAME = "discover_mcp_tools";
/** 任务清单（write_todos，agent 模式，定义见 builtin/write-todos.ts） */
export const TODO_TOOL_NAME = "write_todos";
/** 子 Agent 派生（delegate_task，agent 模式，定义见 conversation 层 turn/sub-agent-dispatcher.ts） */
export const SUB_AGENT_TOOL_NAME = "delegate_task";
/** 后台子任务状态查询（task_status，agent 模式，定义见 turn/sub-agent-dispatcher.ts） */
export const TASK_STATUS_TOOL_NAME = "task_status";
/** 后台子任务停止（task_stop，agent 模式，定义见 turn/sub-agent-dispatcher.ts） */
export const TASK_STOP_TOOL_NAME = "task_stop";

// ---------------------------------------------------------------------------
// 消费者裁剪集合
// ---------------------------------------------------------------------------

/**
 * chat 只读模式剔除的写侧内置工具：chat 会话不允许模型改动文件，
 * 只读语义由代码强制，不依赖 sandbox.level / sandbox.enabled 配置
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
]);

/**
 * 子 Agent 不继承的工具：
 * - write_todos：工具实例闭包持有主会话共享的任务清单状态，派生任务会污染 /todos
 * - delegate_task：自身排除以防无限递归派生
 * - task_status / task_stop：后台节点注册表由主会话调度器独占持有，
 *   子 Agent 不感知后台任务，避免跨会话层的状态污染与递归管理
 */
export const SUB_AGENT_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set([
  TODO_TOOL_NAME,
  SUB_AGENT_TOOL_NAME,
  TASK_STATUS_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
]);
