import fs from "node:fs/promises";
import readline from "node:readline";
import JSON5 from "json5";
import path from "node:path";
import { Config } from "../types/index";
import {
  CONFIG_FILE,
  HOME_DIR,
  PLUGINS_DIR,
  DEFAULT_ROUTER,
} from "../constants";

const ensureDir = async (dir_path: string) => {
  try {
    await fs.access(dir_path);
  } catch {
    await fs.mkdir(dir_path, { recursive: true });
  }
};

export const initDir = async () => {
  await ensureDir(HOME_DIR);
  await ensureDir(PLUGINS_DIR);
};

const createReadline = () => {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
};

const question = (query: string): Promise<string> => {
  return new Promise((resolve) => {
    const rl = createReadline();
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
};

export const readConfigFile = async (): Promise<Config | null> => {
  try {
    const config = await fs.readFile(CONFIG_FILE, "utf-8");
    try {
      // Try to parse with JSON5 first (which also supports standard JSON)
      return JSON5.parse(config);
    } catch (parseError) {
      console.error(`Failed to parse config file at ${CONFIG_FILE}`);
      console.error("Error details:", (parseError as Error).message);
      console.error("Please check your config file syntax.");
      return null;
    }
  } catch (readError: any) {
    // Config file doesn't exist or can't be read, return null instead of exiting
    return null;
  }
};

export const backupConfigFile = async (): Promise<string | null> => {
  try {
    if (await fs.access(CONFIG_FILE).then(() => true).catch(() => false)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${CONFIG_FILE}.${timestamp}.bak`;
      await fs.copyFile(CONFIG_FILE, backupPath);
      
      // Clean up old backups, keeping only the 3 most recent
      try {
        const configDir = path.dirname(CONFIG_FILE);
        const configFileName = path.basename(CONFIG_FILE);
        const files = await fs.readdir(configDir);
        
        // Find all backup files for this config
        const backupFiles = files
          .filter(file => file.startsWith(configFileName) && file.endsWith('.bak'))
          .sort()
          .reverse(); // Sort in descending order (newest first)
        
        // Delete all but the 3 most recent backups
        if (backupFiles.length > 3) {
          for (let i = 3; i < backupFiles.length; i++) {
            const oldBackupPath = path.join(configDir, backupFiles[i]);
            await fs.unlink(oldBackupPath);
          }
        }
      } catch (cleanupError) {
        console.warn("Failed to clean up old backups:", cleanupError);
      }
      
      return backupPath;
    }
  } catch (error) {
    console.error("Failed to backup config file:", error);
  }
  return null;
};

export const writeConfigFile = async (config: Config) => {
  await ensureDir(HOME_DIR);
  
  // Ensure Router configuration is included
  const configWithRouter = {
    ...config,
    Router: config.Router || DEFAULT_ROUTER,
  };
  
  const configWithComment = `${JSON.stringify(configWithRouter, null, 2)}`;
  await fs.writeFile(CONFIG_FILE, configWithComment);
};

export const initConfig = async (): Promise<Config> => {
  // First try to read from config file
  const fileConfig = await readConfigFile();
  
  // Create default config with environment variables
  const envConfig: Config = {
    API_KEY: process.env.AIHUBMIX_API_KEY || "",
    BASE_URL: process.env.AIHUBMIX_BASE_URL,
    LOG: process.env.LOG === "true",
    API_TIMEOUT_MS: process.env.API_TIMEOUT_MS ? parseInt(process.env.API_TIMEOUT_MS) : undefined,
    HOST: process.env.HOST,
    PORT: process.env.PORT ? parseInt(process.env.PORT) : 3456,
    Router: DEFAULT_ROUTER,
  };

  // Merge file config with env config (env takes precedence)
  const finalConfig = {
    ...envConfig,
    ...fileConfig,
  };

  // Validate that we have an API_KEY
  if (!finalConfig.API_KEY) {
    console.error("❌ API_KEY is required. Please set it in your config file or environment variable.");
    console.error("You can set it via:");
    console.error("1. Environment variable: export AIHUBMIX_API_KEY=your_api_key");
    console.error("2. Config file: Create a config.json file with your API_KEY");
    process.exit(1);
  }

  Object.assign(process.env, finalConfig);
  return finalConfig;
}; 
