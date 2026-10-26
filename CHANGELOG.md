## [0.8.1](https://github.com/tanyueran/tx-cli/compare/v0.8.0...v0.8.1) (2026-10-26)

### Bug Fixes

* bash超时改用进程组整杀,修复CI超时用例挂死 ([cc0c4eb](https://github.com/tanyueran/tx-cli/commit/cc0c4eb989e2f3caad94d9492b947ec57645d29e))
## [0.8.0](https://github.com/tanyueran/tx-cli/compare/v0.7.1...v0.8.0) (2026-10-26)

### Features

* 把MCP工具支持服务器级授权与只读默认放行,沙箱模块按config/policy/runtime分层 ([bcb8640](https://github.com/tanyueran/tx-cli/commit/bcb86402ccc1199c291fd4c90a6d9b321b180a14))
* 支持MCP的配置 ([410f842](https://github.com/tanyueran/tx-cli/commit/410f842cc9ba54f0ed996f4da1506f04ba2e00ac))
* 支持skill的引入 ([62adb2c](https://github.com/tanyueran/tx-cli/commit/62adb2c87a79233ee11c4a519f0d31ccb4ee3ac1))
* 新增agent命令 ([691539c](https://github.com/tanyueran/tx-cli/commit/691539c648f8d3d10e1931cbecac2576c60c15da))
* 新增MCP安全加固,工具默认审批并支持通配规则 ([9db2eb1](https://github.com/tanyueran/tx-cli/commit/9db2eb118684f36d532d6be28fb374333e62e1dc))
* 新增write_file,edit_file工具 ([f9fabb8](https://github.com/tanyueran/tx-cli/commit/f9fabb8f9031c9bc1f9c45c579ca6d6928867a82))
* 新增write_todos工具 ([3635ba3](https://github.com/tanyueran/tx-cli/commit/3635ba3ebbb82e21aa9dc80357a9afe0b999031e))
* 新增搜索工具 ([e441037](https://github.com/tanyueran/tx-cli/commit/e441037f6835051165b8a14550d667aff60b3ab4))
* 新增沙箱功能,完善权限验证逻辑 ([e3e262d](https://github.com/tanyueran/tx-cli/commit/e3e262daeb816171cd94ae85c863f9e467d0a499))
* 新增项目级配置(<cwd>/.tx-cli/config.json),移除env配置层 ([fbf54b8](https://github.com/tanyueran/tx-cli/commit/fbf54b85e7a79618229f67b451df381a8325e4ee))
* 沙箱授权项目化,新增MCP roots联动与read-only禁网语义 ([dfbac94](https://github.com/tanyueran/tx-cli/commit/dfbac947ede47384fa248623d39ba5aa9c065261))

### Bug Fixes

* 优化chat,agent 启动时的日志输出 ([b9f3158](https://github.com/tanyueran/tx-cli/commit/b9f31581dbd7a07814a27535052859d493b4ae47))
* 优化MCP的rule的配置逻辑 ([8e990c2](https://github.com/tanyueran/tx-cli/commit/8e990c2a27b8b53e52d349f8b4098649f1c00fa9))
* 移除外部动态tool的功能,仅支持内部工具 ([60eee38](https://github.com/tanyueran/tx-cli/commit/60eee38c5e7ba7f6b5453836d1ab111601918cac))
* 简化chat命令,其不支持MCP,默认思考等级改为low ([b228340](https://github.com/tanyueran/tx-cli/commit/b228340a58a048a705a1546c51f64d44ddcce45a))

### Code Refactoring

* 代码优化 ([bf06fcc](https://github.com/tanyueran/tx-cli/commit/bf06fcca31b0cea6858e8d2c65e96b6562b85b5a))
* 单轮多轮对话统一采用responses api的方式和大模型交互 ([af09c14](https://github.com/tanyueran/tx-cli/commit/af09c1410f9e9a0a513884ee610c4477fd13a80d))
* 目录结构调整 ([c2da634](https://github.com/tanyueran/tx-cli/commit/c2da63404d057a297b7afa642f92c5e012a5e09d))

### Documentation

* 添加agent的相关TODO ([eaea1d4](https://github.com/tanyueran/tx-cli/commit/eaea1d4d0e54cec71e251d64bd4b6b47b302ed82))

### Tests

* 补齐chat/agent命令执行体单测,agent沙箱选项改用联合类型消除断言 ([9d71981](https://github.com/tanyueran/tx-cli/commit/9d71981538f290a02e3f5326093522a4de8e7cdb))
## [0.7.1](https://github.com/tanyueran/tx-cli/compare/v0.7.0...v0.7.1) (2026-10-13)

### Miscellaneous Chores

* 优化自动发布的流程 ([892d5d7](https://github.com/tanyueran/tx-cli/commit/892d5d73506c47c5f8b7fa9218fd1a7e0f76e94d))
* 完善发布日志收集 ([348fbf8](https://github.com/tanyueran/tx-cli/commit/348fbf871ccc5a409b7557973dab8180aae66eac))
# [0.7.0](https://github.com/tanyueran/tx-cli/compare/v0.6.0...v0.7.0) (2026-10-13)


### Performance Improvements

* 代码优化 ([d74d14d](https://github.com/tanyueran/tx-cli/commit/d74d14dd34f45df0fa369067b4d93f93f9b9c9da))



# [0.6.0](https://github.com/tanyueran/tx-cli/compare/v0.5.1-beta.1...v0.6.0) (2026-10-13)


### Features

* 新增copy、chat命令 ([5020e15](https://github.com/tanyueran/tx-cli/commit/5020e15b24b904aecff96a37737951dbc5e6c3a0))



## [0.5.1-beta.1](https://github.com/tanyueran/tx-cli/compare/v0.5.1-beta.0...v0.5.1-beta.1) (2026-09-03)



## [0.5.1-beta.0](https://github.com/tanyueran/tx-cli/compare/v0.5.0...v0.5.1-beta.0) (2026-09-03)



# [0.5.0](https://github.com/tanyueran/tx-cli/compare/v0.4.5...v0.5.0) (2026-04-10)


### Features

* 新增commit-fix命令 ([3458665](https://github.com/tanyueran/tx-cli/commit/3458665de5a355c454fd3b7eddb5d6cb5c6bcddc))



## [0.4.5](https://github.com/tanyueran/tx-cli/compare/v0.4.4...v0.4.5) (2026-01-14)


### Bug Fixes

* 优化错误输出 ([923917b](https://github.com/tanyueran/tx-cli/commit/923917ba9659dc05ce212cb1083abb50978c26cf))
* 输出添加颜色区分 ([e77bb5f](https://github.com/tanyueran/tx-cli/commit/e77bb5f9a5997fe0db05e5bbbaac27931d4667a8))



## [0.4.4](https://github.com/tanyueran/tx-cli/compare/v0.4.3...v0.4.4) (2026-01-14)


### Bug Fixes

* 完善git-rename命令的校验逻辑 ([5f236e5](https://github.com/tanyueran/tx-cli/commit/5f236e58bd943ea45702db57bb2cbeaf481ea1d4))



## [0.4.3](https://github.com/tanyueran/tx-cli/compare/v0.4.2...v0.4.3) (2026-01-14)


### Bug Fixes

* 修复git-rename命令打包安装后获取的文件路径错误问题 ([fd00b37](https://github.com/tanyueran/tx-cli/commit/fd00b378ba0ee965f0e1c23064ad89703614bde7))



## [0.4.2](https://github.com/tanyueran/tx-cli/compare/v0.4.1...v0.4.2) (2026-01-13)


### Bug Fixes

* 完善git-rename命令的校验逻辑 ([eef20f0](https://github.com/tanyueran/tx-cli/commit/eef20f0936a255ead1c6de155e66d173e331a5b9))



## [0.4.1](https://github.com/tanyueran/tx-cli/compare/v0.4.0...v0.4.1) (2026-01-12)


### Bug Fixes

* 修复安装后的报错 ([255fefa](https://github.com/tanyueran/tx-cli/commit/255fefa562c2f06b50f15b7e58091f88982e779d))



# [0.4.0](https://github.com/tanyueran/tx-cli/compare/v0.3.1...v0.4.0) (2026-01-12)


### Features

* 添加git重命名模块名称命令 ([267f224](https://github.com/tanyueran/tx-cli/commit/267f2241ed4b912c32c55b247f6947dc7f8ec0eb))



## [0.3.1](https://github.com/tanyueran/tx-cli/compare/v0.3.0...v0.3.1) (2025-09-22)


### Bug Fixes

* 修复server 自定义header没有设置上的问题 ([3da6517](https://github.com/tanyueran/tx-cli/commit/3da65176eb7002a4afe85c225a5dbe3766965d7e))



# [0.3.0](https://github.com/tanyueran/tx-cli/compare/v0.2.1...v0.3.0) (2025-09-22)


### Features

* server支持设置响应header ([e2ca9e4](https://github.com/tanyueran/tx-cli/commit/e2ca9e43db3d08ed9d6923db2caef86fcf5d86e5))



## [0.2.1](https://github.com/tanyueran/tx-cli/compare/v0.2.0...v0.2.1) (2025-09-10)


### Bug Fixes

* 更新说明文档和一些pgk配置 ([c584788](https://github.com/tanyueran/tx-cli/commit/c5847882e57597f85b1a0e1940c98ca1ce3e2ec7))



# [0.2.0](https://github.com/tanyueran/tx-cli/compare/v0.1.0...v0.2.0) (2025-09-10)


### Bug Fixes

* 优化add,create的命令设计 ([8d366c0](https://github.com/tanyueran/tx-cli/commit/8d366c0d130eec2ec9e2fa8d852edf73e47ecd1f))


### Features

* create命令支持后面跟项目名称;add命令后面支持跟模块名称 ([f4ec6c5](https://github.com/tanyueran/tx-cli/commit/f4ec6c5e6e3dd42f1c0a33d0f159651623f61d35))
* server命令 ([8834c50](https://github.com/tanyueran/tx-cli/commit/8834c504bfeb3d00e947d6ea47f6792d4fbc6d59))



# [0.1.0](https://github.com/tanyueran/tx-cli/compare/v0.0.22-beta.0...v0.1.0) (2025-08-14)


### Features

* 支持tx create 命令创建vite+ts+vue3项目 ([6441de6](https://github.com/tanyueran/tx-cli/commit/6441de6016613c57210cd734c597af998bd85508))



## [0.0.22-beta.0](https://github.com/tanyueran/tx-cli/compare/v0.0.21...v0.0.22-beta.0) (2025-08-12)


### Bug Fixes

* 修复发布beta版本构建失败的bug ([16f414b](https://github.com/tanyueran/tx-cli/commit/16f414b45ebc50bf99f4dbb6be8027ae6bb822f8))
* 修复发布beta版本的逻辑错误 ([6e78bd9](https://github.com/tanyueran/tx-cli/commit/6e78bd9ffbe60578d31fb0e5711b3d292640c9a4))


### Features

* 支持beta版本的自动发布 ([e63fb0b](https://github.com/tanyueran/tx-cli/commit/e63fb0b9f201db630742bd3a0ed0dd0de0e8f913))



## [0.0.21](https://github.com/tanyueran/tx-cli/compare/v0.0.20...v0.0.21) (2025-08-12)


### Features

* 支持选择发布的版本的类型(major、minor、patch) ([19836db](https://github.com/tanyueran/tx-cli/commit/19836db9dba13788cbaa3ce142445c8be45efa7c))



## [0.0.20](https://github.com/tanyueran/tx-cli/compare/v0.0.19...v0.0.20) (2025-08-12)



## 0.0.19 (2025-08-12)


### Bug Fixes

* 简化不必要的模板 ([0e610a4](https://github.com/tanyueran/tx-cli/commit/0e610a47ed739eef46a4483a26d9afee71dbb9e2))
* 自动发布流程错误修复 ([0c76041](https://github.com/tanyueran/tx-cli/commit/0c7604188950d60ea164f373f6e24fa71241e512))


### Features

* 添加自动发布流程 ([4ef63a7](https://github.com/tanyueran/tx-cli/commit/4ef63a7637f80effc652405161c130d1e047a993))
* 自动发布流程,完善日志生成 ([37f04a8](https://github.com/tanyueran/tx-cli/commit/37f04a8c3334c5d410443e0dcf9c2aebe8570ad5))
* 项目初始化 ([2cc4c53](https://github.com/tanyueran/tx-cli/commit/2cc4c53c1c224c10cbf7a98c78718d6199226ee5))



