# @tanyueran/agent-scaffold

tx-cli 的脚手架包（private），为 `create`（创建项目）与 `add`（添加模块）提供模板发现、渲染与生成流程。

- 只依赖 `@tanyueran/agent-common`，不依赖 `agent-core` 或 CLI；
- 通过 `ScaffoldPrompt` / `ScaffoldOutput` 两个最小端口接收交互与输出，TypeScript 结构化类型可直接接收 CLI 的 Channel 实现；
- 模板目录位于包根 `template/`（不在 `src/` 下），构建 CLI 时会被复制进产物 `dist/template`。

## 模板结构

```text
template/
├── project/                 # 项目模板（tx-cli create）
│   └── vue/
│       └── vite-vue-ts/     # label：vite + vue + ts项目
└── module/                  # 模块模板（tx-cli add）
    └── vue/
        └── vue-ts-empty/    # label：vue-ts的空模板
```

模板识别规则：

- 含 `template.json` 的目录即视为一个模板，`label` 字段为展示名称，缺失或非法会直接报错；
- 模板标识为相对种类根目录的路径（如 `vue/vite-vue-ts`），天然唯一，无需额外维护枚举；
- 模板目录内部不再嵌套模板；
- 同一 `kind` 下只有单个模板时跳过选择，多个模板时交互式选择。

渲染规则：

- `.hbs` 文件按 Handlebars 模板渲染后去掉后缀输出，内置 `toPascalCase` helper；
- 文件名映射：`.hbs` 后缀去掉，`_gitignore` 还原为 `.gitignore`（npm 发包会排除 `.gitignore`）；
- 其他文件按原样拷贝，`template.json` 属于模板配置，不会生成到目标目录。

## 生成流程

`runScaffold` 的固定顺序：

1. 确定名称：命令行传入（允许相对路径）或交互式输入；
2. 选择模板：单模板直接使用，多模板交互选择；
3. 计算目标路径：相对路径基于调用方传入的 `cwd`（CLI 为命令执行目录）解析，模板内使用的名称只取路径最后一段；
4. 覆盖确认：目标目录已存在时必须确认，确认后删除原目录再生成，取消则不做任何修改；
5. 渲染生成：递归拷贝并渲染模板文件。

## 使用示例

```ts
import { runScaffold } from "@tanyueran/agent-scaffold";

const result = await runScaffold({
  name: "./apps/admin",       // 可省略，省略时交互式输入
  nameLabel: "项目名称",
  kind: "project",            // "project" | "module"
  prompt,                     // 实现 ScaffoldPrompt：input / select / confirm
  output,                     // 实现 ScaffoldOutput：success / warn
  cwd: process.cwd(),         // 相对路径的解析基准
});

// 用户取消覆盖时返回 null
if (!result) {
  return;
}
console.log(result.name, result.targetPath);
```

CLI 侧对应命令：`tx-cli create [project-name]` 与 `tx-cli add [module-name]`，命令实现见 `packages/cli/src/program/command/`。

## 新增模板

1. 在 `template/<kind>/` 下新建目录；
2. 添加 `template.json`，至少包含 `label`；
3. 需要变量替换的文件使用 `.hbs` 后缀，可用 `{{name}}` 与 `{{toPascalCase name}}`；
4. 需要生成 `.gitignore` 时在模板中命名为 `_gitignore`。

无需改动代码，模板在运行时按目录结构扫描。

## 开发

```bash
pnpm --filter @tanyueran/agent-scaffold type-check
pnpm --filter @tanyueran/agent-scaffold build
```
