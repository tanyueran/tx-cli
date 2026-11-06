/** 模板种类，同时也是 template 目录下的一级子目录名 */
export type TemplateKind = "project" | "module";

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
