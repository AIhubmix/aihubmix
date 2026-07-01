// 核心类型定义
export interface MessageParam {
  role: string;
  content: string | any[];
}

export interface Tool {
  name: string;
  description?: string;
  input_schema?: any;
}

export interface MessageCreateParamsBase {
  messages: MessageParam[];
  system?: string | any[];
  tools?: Tool[];
}

// 配置相关类型
export interface Provider {
  name: string;
  api_base_url: string;
  api_key: string;
  models: string[];
}

export interface Router {
  default: string;
  background?: string;
  think?: string;
  longContext?: string;
  longContextThreshold?: number;
  webSearch?: string;
}

export interface Config {
  API_KEY: string;
  BASE_URL?: string;
  LOG?: boolean;
  API_TIMEOUT_MS?: number;
  HOST?: string;
  PORT?: number;
  Router?: Router;
}

// 服务器相关类型
export interface ServerConfig {
  jsonPath: string;
  initialConfig: any;
}

// CLI 相关类型
export interface RunOptions {
  port?: number;
} 
