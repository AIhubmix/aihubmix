# Claude Code Router

<div align="center">
  <div style="margin-bottom: 20px;">
    <a href="./README.zh.md" style="margin: 0 10px; padding: 8px 16px; background-color: #f0f0f0; color: #333; text-decoration: none; border-radius: 4px;">中文</a>
    <a href="./README.md" style="margin: 0 10px; padding: 8px 16px; background-color: #007acc; color: white; text-decoration: none; border-radius: 4px;">English</a>
    <a href="./README.ja.md" style="margin: 0 10px; padding: 8px 16px; background-color: #f0f0f0; color: #333; text-decoration: none; border-radius: 4px;">日本語</a>
  </div>
</div>

A simplified Claude Code routing service that supports multiple AI models.

## Features

- 🚀 Simplified configuration management
- 🔄 Automatic routing to different AI models
- ⚡ Fast startup and shutdown
- 🔧 Easy configuration

## Installation

**Requirements:**
- Node.js >= 20

First, make sure you have Claude Code installed:
```bash
npm install -g @anthropic-ai/claude-code
```

Then, install @aihubmix/claude-code:
```bash
npm install -g @aihubmix/claude-code
```

## Configuration

Two configuration methods are now supported. For detailed instructions, see [CONFIGURATION.md](./CONFIGURATION.md).

### 1. Environment Variables (Recommended)

```bash
export AIHUBMIX_API_KEY="your-api-key-here"
export AIHUBMIX_BASE_URL="https://aihubmix.com"  # Optional, upstream API domain
export HOST="127.0.0.1"  # Optional
export PORT="3456"        # Optional
export LOG="true"         # Optional
export API_TIMEOUT_MS="30000"  # Optional
```

> `AIHUBMIX_BASE_URL` lets you switch the upstream access domain (do not include `/v1/...`).
> Default: `https://aihubmix.com`; you can replace it with another domain as needed.

### 2. Configuration File

Configuration file located at `~/.aihubmix-claude-code/config.json`:

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

**Note**: Environment variables take precedence over configuration files.

## Usage

### Start Service

```bash
acc start
```

### Stop Service

```bash
acc stop
```

### Restart Service

```bash
acc restart
```

### Check Status

```bash
acc status
```

### Execute Code Command

```bash
acc code "Write a Hello World function"
```

### Check Version

```bash
acc version
```

### Show Help

```bash
acc help
```

## Routing Rules

### Default Model Configuration

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

### Routing Logic

- **Default**: Uses `claude-sonnet-4-20250514` model
- **Background Tasks**: Uses `claude-sonnet-4-20250514` model when the model is `claude-3-5-haiku`
- **Thinking Tasks**: Uses `claude-sonnet-4-20250514` model when the request contains `thinking` parameter
- **Long Context**: Uses `gpt-4.1` model when token count exceeds 60000
- **Web Search**: Uses `gemini-2.0-flash-search` model when the request contains `web_search` tools

### Custom Router Configuration

You can customize the `Router` section in the configuration file to override default model configurations:

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

#### Router Configuration Items

- **default**: Default model to use
- **background**: Model for background tasks
- **think**: Model for thinking tasks  
- **longContext**: Model for long context tasks
- **longContextThreshold**: Token threshold to trigger long context model (default 60000)
- **webSearch**: Model for web search tasks
