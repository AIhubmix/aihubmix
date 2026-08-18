# Aihubmix SDK

<div align="center">

[![English](https://img.shields.io/badge/Language-English-blue.svg)](README.md)
[![中文](https://img.shields.io/badge/Language-中文-red.svg)](README.zh.md)

</div>

## Project Introduction

One Gateway, Infinite Models；one-stop request: OpenAI, Claude, Gemini, DeepSeek, Qwen, and over 500 AI models.

🌐 **[aihubmix.com](https://aihubmix.com)** · 📚 **[Documentation](https://docs.aihubmix.com)** · 🧭 **[Browse all models & pricing](https://aihubmix.com/models)** · 🆓 **[Free models](https://aihubmix.com/models/free)**

Popular models on AIHubMix: [Qwen3.8 Max Preview](https://aihubmix.com/model/qwen3.8-max-preview) · [Kimi K3](https://aihubmix.com/model/kimi-k3) · [GLM 5.2](https://aihubmix.com/model/glm-5.2) · [Claude Opus 5](https://aihubmix.com/model/claude-opus-5) · [Gemini 3.6 Flash](https://aihubmix.com/model/gemini-3.6-flash) · [DeepSeek V4 Flash](https://aihubmix.com/model/deepseek-v4-flash) · [Grok 4.5](https://aihubmix.com/model/grok-4.5) · [GPT-5.6 Luna](https://aihubmix.com/model/gpt-5.6-luna)

## Features

### @aihubmix/claude-code
**Claude Code Router Package** - Claude Code routing service

- **Features**：
  - Simplified configuration management
  - Automatic routing to different AI models
  - Quick start and shutdown
  - Easy configuration
  - Support for multiple routing rules
  - Long context processing
  - Web search support
  - Background task processing

- **Use Cases**：
  - Claude Code tool integration
  - Development tool integration
  - Code editor plugins
  - Automated code generation
  - Intelligent task routing

📖 **[View Detailed Documentation](./packages/claude-code/README.md)** | 📦 **[npm package](https://www.npmjs.com/package/@aihubmix/claude-code)**

### @aihubmix/mcp
**MCP (Model Context Protocol) Package** - Model Context Protocol implementation

- **Features**：
  - MCP protocol standard implementation
  - Tool and resource management
  - File operation support
  - Image generation tools
  - API call tools
  - Multi-client support (Cursor, Cherry Studio, Claude Desktop)
  - Flexible configuration options

- **Use Cases**：
  - AI assistant integration
  - Toolchain development
  - Automated workflows
  - Code editor extensions
  - Desktop application integration

📖 **[View Detailed Documentation](./packages/mcp/README.md)** | 📦 **[npm package](https://www.npmjs.com/package/@aihubmix/mcp)**

> ℹ️ **`@aihubmix/ai-sdk-provider` has moved.** It is no longer maintained in this repository and now lives in its own standalone project: **[AIhubmix/ai-sdk-provider](https://github.com/AIhubmix/ai-sdk-provider)**.


## PR Guidelines

### Commit Message Format

Use [Conventional Commits](https://www.conventionalcommits.org/) specification：

```
<type>[<scope>]: <description>

[optional body]

[optional footer(s)]
```

### Type Descriptions

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation updates
- `style`: Code formatting changes (changes that don't affect code execution)
- `refactor`: Code refactoring (code changes that are neither new features nor bug fixes)
- `perf`: Performance optimization
- `test`: Testing related
- `build`: Build system or external dependency changes
- `ci`: CI/CD related changes
- `chore`: Build process or auxiliary tool changes
- `revert`: Revert to previous version

### Package Name Specification

Specify package name in commit messages, format: `<type>[<scope>]: <description>`

#### Examples

```
feat[claude-code]: Add new model support
fix[claude-code]: Fix code generation bug
docs[mcp]: Update API documentation
refactor[claude-code]: Refactor routing logic
test[claude-code]: Add unit tests
chore[mcp]: Update dependency versions
perf[mcp]: Optimize response speed
```

### PR Title Guidelines

PR titles should be concise and clear, format: `<type>[<scope>]: <description>`

#### Examples

```
feat[claude-code]: Add new model support
fix[claude-code]: Fix multi-line code generation issue
docs[mcp]: Improve tool usage documentation
refactor[mcp]: Refactor tool routing logic
```

### PR Description Template

```markdown
## Change Type
- [ ] New feature (feat)
- [ ] Bug fix (fix)
- [ ] Documentation (docs)
- [ ] Style (style)
- [ ] Refactor (refactor)
- [ ] Performance optimization (perf)
- [ ] Test (test)
- [ ] Build (build)
- [ ] CI/CD (ci)
- [ ] Build tools (chore)
- [ ] Revert (revert)

## Scope
- [ ] claude-code
- [ ] mcp

## Change Description
Briefly describe the content and reason for this change

## Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing completed
- [ ] Type checking passes
- [ ] Code formatting check passes

## Related Issues
Closes #<issue-number>
Fixes #<issue-number>

## Checklist
- [ ] Code follows project coding standards
- [ ] New features include corresponding tests
- [ ] Documentation updated (if API changes)
- [ ] Commit messages follow Conventional Commits specification
- [ ] All CI checks pass
```

### Code Review Requirements

1. **Feature Completeness**: Ensure new features are complete and work properly
2. **Test Coverage**: New features should include corresponding tests, test coverage should not decrease
3. **Documentation Updates**: If there are API changes, update relevant documentation and type definitions
4. **Type Safety**: TypeScript projects should ensure type safety, no type errors
5. **Performance Considerations**: Avoid introducing performance issues, conduct performance testing when necessary
6. **Code Quality**: Follow project coding standards, code should be concise and readable
7. **Backward Compatibility**: Ensure changes don't break existing functionality

### Merge Requirements

- At least 1 reviewer approval required
- Code coverage cannot decrease
- No major security vulnerabilities
- Commit messages comply with specifications
- Code passes all quality checks

### Development Workflow

1. **Fork Project**: Fork the main repository to your GitHub account
2. **Create Branch**: Create a feature branch from the main branch
   ```bash
   git checkout -b feat/your-feature-name
   ```
3. **Develop Feature**: Develop in the corresponding package
4. **Run Tests**: Ensure all tests pass
   ```bash
   pnpm test
   pnpm lint
   pnpm type-check
   ```
5. **Commit Code**: Use standardized commit messages
   ```bash
   git commit -m "feat[package-name]: your commit message"
   ```
6. **Push Branch**: Push your feature branch
   ```bash
   git push origin feat/your-feature-name
   ```
7. **Create PR**: Create Pull Request on GitHub
8. **Code Review**: Wait for reviewer feedback and handle responses
9. **Merge**: Merge to main branch after review approval

### Release Process

1. **Create Changeset**: Use `pnpm changeset` to record changes
2. **Update Version**: Use `pnpm version` to update version number
3. **Build Project**: Ensure build success
   ```bash
   pnpm build
   ```
4. **Publish**: Use `pnpm release` to publish to npm
5. **Create Release**: Create Release on GitHub


## Notes

- Ensure Node.js 18+ version is used
- Use pnpm as package manager
- All packages are linked through workspace, no manual publishing required for local use
- Ensure PR guidelines are followed before submitting code

