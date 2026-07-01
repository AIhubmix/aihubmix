# Claude Code Router

<div align="center">
  <div style="margin-bottom: 20px;">
    <a href="./README.zh.md" style="margin: 0 10px; padding: 8px 16px; background-color: #007acc; color: white; text-decoration: none; border-radius: 4px;">中文</a>
    <a href="./README.md" style="margin: 0 10px; padding: 8px 16px; background-color: #f0f0f0; color: #333; text-decoration: none; border-radius: 4px;">English</a>
    <a href="./README.ja.md" style="margin: 0 10px; padding: 8px 16px; background-color: #f0f0f0; color: #333; text-decoration: none; border-radius: 4px;">日本語</a>
  </div>
</div>

一个简化的 Claude Code 路由服务，支持多种 AI 模型。

## 功能特性

- 🚀 简化的配置管理
- 🔄 自动路由到不同的 AI 模型
- ⚡ 快速启动和停止
- 🔧 易于配置

## 安装

**环境要求：**
- Node.js >= 20

首先，请确保您已安装 Claude Code：
```bash
npm install -g @anthropic-ai/claude-code

```
然后，安装 @aihubmix/claude-code：
```bash
npm install -g @aihubmix/claude-code
```

## 配置

现在支持两种配置方式，详细说明请查看 [CONFIGURATION.md](./CONFIGURATION.md)。

### 1. 环境变量配置（推荐）

```bash
export AIHUBMIX_API_KEY="your-api-key-here"
export AIHUBMIX_BASE_URL="https://aihubmix.com"  # 可选，上游 API 访问域名
export HOST="127.0.0.1"  # 可选
export PORT="3456"        # 可选
export LOG="true"         # 可选
export API_TIMEOUT_MS="30000"  # 可选
```

> `AIHUBMIX_BASE_URL` 用于更换上游访问域名（不要带 `/v1/...` 路径）。
> 默认值：`https://aihubmix.com`，可按需替换成其他域名。

### 2. 配置文件

配置文件位于 `~/.aihubmix-claude-code/config.json`：

```json
{
  "API_KEY": "your-api-key-here",
  "BASE_URL": "https://aihubmix.com",
  "HOST": "127.0.0.1",
  "PORT": 3456,
  "LOG": true,
  "API_TIMEOUT_MS": 30000,
  "Router": {
    "default": "claude-sonnet-4-20250514",
    "background": "claude-3-5-haiku-20241022",
    "think": "claude-sonnet-4-20250514",
    "longContext": "gpt-4.1",
    "longContextThreshold": 60000,
    "webSearch": "gemini-2.0-flash-search"
  }
}
```

**注意**: 环境变量的优先级高于配置文件。



## 使用方法

### 启动服务

```bash
acc start
```

### 停止服务

```bash
acc stop
```

### 重启服务

```bash
acc restart
```

### 查看状态

```bash
acc status
```

### 执行代码命令

```bash
acc code "Write a Hello World function"
```

### 查看版本

```bash
acc version
```

### 查看帮助

```bash
acc help
```

## 路由规则

### 默认模型配置

```json
{
  "default": "claude-sonnet-4-20250514",
  "background": "claude-3-5-haiku-20241022", 
  "think": "claude-sonnet-4-20250514",
  "longContext": "gpt-4.1",
  "longContextThreshold": 60000,
  "webSearch": "gemini-2.0-flash-search"
}
```

### 路由逻辑

- **默认**: 使用 `claude-sonnet-4-20250514` 模型
- **背景任务**: 当模型为 `claude-3-5-haiku` 时，使用 `claude-sonnet-4-20250514` 模型
- **思考任务**: 当请求包含 `thinking` 参数时，使用 `claude-sonnet-4-20250514` 模型
- **长上下文**: 当 token 数超过 60000 时，使用 `gpt-4.1` 模型
- **网络搜索**: 当请求包含 `web_search` 工具时，使用 `gemini-2.0-flash-search` 模型

### 自定义路由配置

你可以在配置文件中自定义 `Router` 部分来覆盖默认的模型配置：

```json
{
  "Router": {
    "default": "your-custom-model",
    "background": "your-background-model", 
    "think": "your-thinking-model",
    "longContext": "your-long-context-model",
    "longContextThreshold": 50000,
    "webSearch": "your-web-search-model"
  }
}
```

#### Router 配置项说明

- **default**: 默认使用的模型
- **background**: 背景任务使用的模型
- **think**: 思考任务使用的模型  
- **longContext**: 长上下文任务使用的模型
- **longContextThreshold**: 触发长上下文模型的 token 阈值（默认 60000）
- **webSearch**: 网络搜索任务使用的模型

### GPT-5 Reasoning 级别支持

GPT-5 模型现在支持不同的 reasoning effort 级别，您可以通过以下方式选择：

- `gpt-5` - 使用默认的 medium 级别
- `gpt-5(high)` - 高级别推理，最大化质量但速度较慢
- `gpt-5(medium)` - 中级别推理，平衡质量和速度
- `gpt-5(low)` - 低级别推理，更快的响应速度
- `gpt-5(minimal)` - 最小推理，超低延迟场景

#### 使用示例

1. **在 Claude Code 中选择模型时**：
   - 选择 `gpt-5(high)` 来进行深度思考任务
   - 选择 `gpt-5(minimal)` 来进行快速简单任务

2. **在配置文件中设置**：
```json
{
  "Router": {
    "think": "gpt-5(high)",  // 思考任务使用高级别推理
    "default": "gpt-5"       // 默认使用中级别
  }
}
```

