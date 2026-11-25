/** 模板种类，同时也是 template 目录下的一级子目录名 */
export type TemplateKind = "project" | "module";

/**
 * 脚手架流程所需的交互提示最小端口
 * 利用 TypeScript 结构化类型直接接收各端 Channel（如 CLI 的 PromptChannel），
 * 不依赖 core/channels，也不为此新增 contracts 包
 */
export interface ScaffoldPrompt {
  /**
   * 输入对话（自由文本输入）
   * @param {string} message - 提示信息
   * @returns {Promise<string>} 用户输入的文本
   */
  input(message: string): Promise<string>;
  /**
   * 选择对话（从选项中选择一项）
   * @param {string} message - 提示信息
   * @param {Array<{ title: string; value: T }>} choices - 选项列表
   * @returns {Promise<T>} 用户选择的值
   */
  select<T>(message: string, choices: Array<{ title: string; value: T }>): Promise<T>;
  /**
   * 确认对话（是 / 否）
   * @param {string} message - 提示信息
   * @returns {Promise<boolean>} 用户选择（true=是，false=否）
   */
  confirm(message: string): Promise<boolean>;
}

/** 脚手架流程所需的语义化输出最小端口：颜色与展示样式由各端自行决定 */
export interface ScaffoldOutput {
  /**
   * 输出成功信息
   * @param {string} message - 成功文本
   * @returns {void}
   */
  success(message: string): void;
  /**
   * 输出警告信息
   * @param {string} message - 警告文本
   * @returns {void}
   */
  warn(message: string): void;
}

/** 模板元数据，由模板目录下的 template.json 与目录结构推导得出 */
export type TemplateMeta = {
  /** 展示给用户的名称，来自 template.json 的 label */
  label: string;
  /** 模板唯一标识，为相对于种类根目录的路径，如 vue/vite-vue-ts */
  value: string;
  /** 模板目录的绝对路径 */
  path: string;
};

/** 注入模板的渲染数据 */
export type TemplateData = {
  [key: string]: unknown;
};
