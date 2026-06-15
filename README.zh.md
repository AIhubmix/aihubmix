# Aihubmix SDK

<div align="center">

[![English](https://img.shields.io/badge/Language-English-blue.svg)](README.md)
[![中文](https://img.shields.io/badge/Language-中文-red.svg)](README.zh.md)

</div>

## 项目介绍

One Gateway, Infinite Models；one-stop request: OpenAI, Claude, Gemini, DeepSeek, Qwen, and over 500 AI models.

## 功能介绍

### @aihubmix/claude-code
**Claude Code Router包** - Claude Code路由服务

- **功能特性**：
  - 简化的配置管理
  - 自动路由到不同的AI模型
  - 快速启动和关闭
  - 易于配置
  - 支持多种路由规则
  - 长上下文处理
  - 网络搜索支持
  - 后台任务处理

- **使用场景**：
  - Claude Code工具集成
  - 开发工具集成
  - 代码编辑器插件
  - 自动化代码生成
  - 智能任务路由

📖 **[查看详细文档](./packages/claude-code/README.md)** | 📦 **[npm包](https://www.npmjs.com/package/@aihubmix/claude-code)**

### @aihubmix/mcp
**MCP (Model Context Protocol)包** - 模型上下文协议实现

- **功能特性**：
  - MCP协议标准实现
  - 工具和资源管理
  - 文件操作支持
  - 图像生成工具
  - API调用工具
  - 多客户端支持（Cursor、Cherry Studio、Claude Desktop）
  - 灵活的配置选项

- **使用场景**：
  - AI助手集成
  - 工具链开发
  - 自动化工作流
  - 代码编辑器扩展
  - 桌面应用集成

📖 **[查看详细文档](./packages/mcp/README.md)** | 📦 **[npm包](https://www.npmjs.com/package/@aihubmix/mcp)**

> ℹ️ **`@aihubmix/ai-sdk-provider` 已迁移。** 该包不再在本仓库维护，已迁移到独立项目单独维护：**[AIhubmix/ai-sdk-provider](https://github.com/AIhubmix/ai-sdk-provider)**。


## PR规范

### 提交信息格式

使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
<type>[<scope>]: <description>

[optional body]

[optional footer(s)]
```

### 类型说明

- `feat`: 新功能
- `fix`: 修复bug
- `docs`: 文档更新
- `style`: 代码格式调整（不影响代码运行的变动）
- `refactor`: 代码重构（既不是新增功能，也不是修改bug的代码变动）
- `perf`: 性能优化
- `test`: 测试相关
- `build`: 构建系统或外部依赖变动
- `ci`: CI/CD相关变动
- `chore`: 构建过程或辅助工具的变动
- `revert`: 回滚到上一个版本

### 包名规范

在提交信息中指定包名，格式为：`<type>[<scope>]: <description>`

#### 示例

```
feat[claude-code]: 添加新模型支持
fix[claude-code]: 修复代码生成bug
docs[mcp]: 更新API文档
refactor[claude-code]: 重构路由逻辑
test[claude-code]: 添加单元测试
chore[mcp]: 更新依赖版本
perf[mcp]: 优化响应速度
```

### PR标题规范

PR标题应简洁明了，格式为：`<type>[<scope>]: <description>`

#### 示例

```
feat[claude-code]: 添加新模型支持
fix[claude-code]: 修复多行代码生成问题
docs[mcp]: 完善工具使用文档
refactor[mcp]: 重构工具路由逻辑
```

### PR描述模板

```markdown
## 变更类型
- [ ] 新功能 (feat)
- [ ] 修复 (fix)
- [ ] 文档 (docs)
- [ ] 样式 (style)
- [ ] 重构 (refactor)
- [ ] 性能优化 (perf)
- [ ] 测试 (test)
- [ ] 构建 (build)
- [ ] CI/CD (ci)
- [ ] 构建工具 (chore)
- [ ] 回滚 (revert)

## 影响范围
- [ ] claude-code
- [ ] mcp

## 变更描述
简要描述此次变更的内容和原因

## 测试
- [ ] 单元测试通过
- [ ] 集成测试通过
- [ ] 手动测试完成
- [ ] 类型检查通过
- [ ] 代码格式检查通过

## 相关Issue
Closes #<issue-number>
Fixes #<issue-number>

## 检查清单
- [ ] 代码遵循项目编码规范
- [ ] 新功能包含相应的测试
- [ ] 文档已更新（如有API变更）
- [ ] 提交信息遵循Conventional Commits规范
- [ ] 所有CI检查通过
```

### 代码审查要求

1. **功能完整性**：确保新功能完整且可正常工作
2. **测试覆盖**：新功能应包含相应的测试，测试覆盖率不应降低
3. **文档更新**：如有API变更，需更新相关文档和类型定义
4. **类型安全**：TypeScript项目需确保类型安全，无类型错误
5. **性能考虑**：避免引入性能问题，必要时进行性能测试
6. **代码质量**：遵循项目编码规范，代码简洁易读
7. **向后兼容**：确保变更不会破坏现有功能

### 合并要求

- 至少需要1个审查者批准
- 代码覆盖率不能降低
- 无重大安全漏洞
- 提交信息符合规范
- 代码已通过所有质量检查

### 开发工作流

1. **Fork项目**：Fork主仓库到你的GitHub账户
2. **创建分支**：从main分支创建功能分支
   ```bash
   git checkout -b feat/your-feature-name
   ```
3. **开发功能**：在相应包中进行开发
4. **运行测试**：确保所有测试通过
   ```bash
   pnpm test
   pnpm lint
   pnpm type-check
   ```
5. **提交代码**：使用规范的提交信息
   ```bash
   git commit -m "feat[package-name]: your commit message"
   ```
6. **推送分支**：推送你的功能分支
   ```bash
   git push origin feat/your-feature-name
   ```
7. **创建PR**：在GitHub上创建Pull Request
8. **代码审查**：等待审查者审查并处理反馈
9. **合并**：审查通过后合并到main分支

### 发布流程

1. **创建变更集**：使用 `pnpm changeset` 记录变更
2. **更新版本**：使用 `pnpm version` 更新版本号
3. **构建项目**：确保构建成功
   ```bash
   pnpm build
   ```
4. **发布**：使用 `pnpm release` 发布到npm
5. **创建发布**：在GitHub上创建Release


## 注意事项

- 确保使用 Node.js 18+ 版本
- 使用 pnpm 作为包管理器
- 所有包都通过 workspace 链接，无需手动发布即可在本地使用
- 提交代码前请确保遵循PR规范 
