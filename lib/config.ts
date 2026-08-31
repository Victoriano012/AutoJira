import fs from "fs";
import os from "os";
import path from "path";
import { DEFAULT_MODEL } from "./models";

/** App-wide settings, shared by every project. */
const CONFIG = path.join(os.homedir(), ".autojira", "config.json");

export interface AppConfig {
  /** Model override for the AI agents; unset = `DEFAULT_MODEL`. */
  model?: string;
}

export function readConfig(): AppConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
}

export function writeConfig(config: AppConfig) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));
}

/** The configured model, shared by every agent entry point. */
export function selectedModel(): string {
  return readConfig().model || DEFAULT_MODEL;
}
