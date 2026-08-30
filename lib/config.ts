import fs from "fs";
import os from "os";
import path from "path";

/** App-wide settings, shared by every project. */
const CONFIG = path.join(os.homedir(), ".autojira", "config.json");

export interface AppConfig {
  /** Model override for the AI agents; unset = SDK default. */
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

/** `{ model }` when configured, `{}` otherwise — spread into query() options. */
export function modelOption(): { model?: string } {
  const model = readConfig().model;
  return model ? { model } : {};
}
