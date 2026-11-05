# Phase 6: 打磨与发布

> 前置依赖：Phase 4 和 Phase 5 完成
> 预计产出：完整的测试覆盖、更新的文档、可发布的版本

## 概述

对前面所有 Phase 的成果进行打磨：补全测试、更新文档、配置发布流程。

---

## Task 6.1: 集成测试补全

### 目标

为桌面端和云端服务编写集成测试。

### 涉及文件

- `test/` — 新增集成测试文件

### 步骤

#### Step 1: Channel 接口测试

为每个 Channel 实现编写单元测试：
- CLI Channel 测试
- IPC Channel 测试（桌面端）
- WebSocket Channel 测试（云端）

#### Step 2: 多 Provider 配置测试

- 配置迁移测试
- ProviderRegistry 测试
- 模型切换测试

#### Step 3: 云端 API 测试

- 认证 API 测试
- 用户管理 API 测试
- WebSocket 消息测试

#### Step 4: 端到端测试

- CLI 端到端测试（确保功能不变）
- 桌面端关键流程测试
- 云端关键流程测试

### 验收标准

- [ ] 所有测试通过
- [ ] 测试覆盖率不低于改造前

---

## Task 6.2: 文档更新

### 目标

更新项目文档，反映新的架构和使用方式。

### 涉及文件

- `docs/ARCHITECTURE.md` — 更新
- `docs/DESIGN-NOTES.md` — 更新
- `docs/AGENT.md` — 更新
- `docs/CHAT.md` — 更新
- `README.md` — 更新

### 步骤

#### Step 1: 更新 ARCHITECTURE.md

- 更新目录结构为 monorepo 结构
- 添加桌面端架构说明
- 添加云端服务架构说明
- 添加 Channel 抽象层说明

#### Step 2: 更新 DESIGN-NOTES.md

- 记录 I/O 解耦的设计决策
- 记录多 Provider 配置的设计决策
- 记录桌面端和云端的设计决策

#### Step 3: 更新使用文档

- 桌面端使用指南
- 云端部署指南
- 多 Provider 配置指南

#### Step 4: 更新 README.md

- 更新项目介绍
- 添加桌面端和云端入口
- 更新安装和使用说明

### 验收标准

- [ ] 所有文档反映最新架构
- [ ] 新功能有使用文档

---

## Task 6.3: 发布流程

### 目标

配置版本管理和发布流程。

### 涉及文件

- `package.json`（根）— 修改
- `.github/workflows/` — 新建 CI/CD 配置

### 步骤

#### Step 1: 配置版本管理

选择版本管理方案：
- 方案 A：使用 changesets（推荐，适合 monorepo）
- 方案 B：手动版本管理

#### Step 2: 配置 npm publish

确保 `@tx-cli/cli` 包能正确发布到 npm：

```json
{
  "name": "@tanyueran/cli",
  "version": "0.12.0",
  "bin": {
    "tx-cli": "./bin/tx-cli"
  },
  "files": ["bin", "dist"]
}
```

#### Step 3: 配置 GitHub Actions

创建 `.github/workflows/ci.yml`：

```yaml
name: CI
on:
  push:
    branches: [main, feature/expand]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.5.2
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm type-check
      - run: pnpm test
      - run: pnpm build
```

#### Step 4: 配置桌面端发布

创建 `.github/workflows/desktop-release.yml`，配置 macOS / Windows / Linux 打包发布。

### 验收标准

- [ ] CI 流程正常运行
- [ ] npm 包能正常发布
- [ ] 桌面端安装包能正常构建
