# language: zh-CN
功能:使用脚手架创建项目并添加模块
  作为 CLI 使用者
  我希望通过命令参数或交互输入选择名称和模板
  以便完整生成所需文件，并避免误覆盖已有内容

  背景:
    假如 在隔离的工作目录中运行 tx-cli
    而且 每个场景使用独立的目标目录和模板环境
    而且 未特别说明时，项目和模块各只有当前内置的一套模板

  场景大纲:命令行已提供名称且只有一个模板时直接生成
    假如 可用的<模板类型>模板只有"<模板标识>"
    而且 目标路径"<名称>"不存在
    当 执行命令"<命令> <名称>"
    那么 在"<名称>"目录下生成"<模板标识>"对应的完整内容
    而且 不询问<名称标签>
    而且 不提示选择模板
    而且 输出包含"<成功提示>"

    例子:
      | 命令               | 名称         | 模板类型 | 模板标识          | 名称标签 | 成功提示   |
      | tx-cli create      | shop-admin   | 项目     | vue/vite-vue-ts   | 项目名称 | 创建成功   |
      | tx-cli add         | user-profile | 模块     | vue/vue-ts-empty  | 模块名   | 模块已生成 |

  场景大纲:命令未提供名称时通过交互补录后生成
    假如 可用的<模板类型>模板只有"<模板标识>"
    而且 目标路径"<输入名称>"不存在
    当 执行命令"<命令>"
    而且 在提示"<名称提示>"后输入"<输入名称>"
    那么 在"<输入名称>"目录下生成"<模板标识>"对应的完整内容
    而且 生成文件"<输入名称>/<生成文件>"

    例子:
      | 命令          | 模板类型 | 模板标识         | 名称提示       | 输入名称    | 生成文件      |
      | tx-cli create | 项目     | vue/vite-vue-ts  | 请输入项目名称 | web-console | package.json  |
      | tx-cli add    | 模块     | vue/vue-ts-empty | 请输入模块名   | order-list  | index.vue     |

  场景:存在多个模板时按用户选择生成
    假如 当前提供"Vue 基础项目"和"Vue 管理后台"两套项目模板
    而且 目标路径"demo-app"不存在
    当 执行命令"tx-cli create demo-app"
    而且 在提示"请选择模板"后选择"Vue 管理后台"
    那么 "demo-app"目录的内容与"Vue 管理后台"模板一致
    而且 不混入"Vue 基础项目"模板的内容

  场景:目标已存在且拒绝覆盖时保持原内容
    假如 当前目录已有"shop-admin/README.md"，其内容为"我的项目说明"
    而且 当前目录已有"shop-admin/src/local.ts"，其内容为"保留本地修改"
    当 执行命令"tx-cli create shop-admin"
    而且 在覆盖确认中选择"否"
    那么 输出"已取消，未做任何修改"
    而且 "shop-admin/README.md"的内容仍为"我的项目说明"
    而且 "shop-admin/src/local.ts"的内容仍为"保留本地修改"
    而且 不生成"shop-admin/package.json"
    而且 不输出"创建成功"

  场景:确认覆盖后移除旧内容并重新生成模块
    假如 当前目录已有"user-profile/obsolete.txt"
    而且 当前目录已有"user-profile/index.vue"，其内容为"旧模块内容"
    当 执行命令"tx-cli add user-profile"
    而且 在覆盖确认中选择"是"
    那么 重新生成"user-profile/index.vue"和"user-profile/index.module.scss"
    而且 "user-profile/index.vue"包含"user-profile"
    而且 "user-profile/index.vue"不再包含"旧模块内容"
    而且 "user-profile/obsolete.txt"已删除
    而且 输出包含"模块已生成"

  场景:生成项目时渲染变量并还原特殊文件名
    假如 目标路径"my-shop"不存在
    当 执行命令"tx-cli create my-shop"
    那么 生成文件"my-shop/package.json"
    而且 "my-shop/package.json"中的"name"字段为"my-shop"
    而且 不生成"my-shop/package.json.hbs"
    而且 生成文件"my-shop/.gitignore"
    而且 "my-shop/.gitignore"包含"node_modules"
    而且 不生成"my-shop/_gitignore"

  场景:静态文件和嵌套目录按模板原样生成
    假如 目标路径"portal"不存在
    当 执行命令"tx-cli create portal"
    那么 "portal/index.html"与项目模板中的"index.html"逐字节一致
    而且 "portal/public/favicon.ico"与项目模板中的"public/favicon.ico"逐字节一致
    而且 "portal/src/views/home/index.vue"与项目模板中的"src/views/home/index.vue"逐字节一致
    而且 "portal/build/plugins/vite-plugin-html-replace-flag.js"与项目模板中的"build/plugins/vite-plugin-html-replace-flag.js"逐字节一致
