import fs from "fs";
import os from "os";
import path from "path";
import { defaultProject, Project } from "./types";

/** New projects are created as subfolders of this directory. */
const BASE = process.env.AUTOJIRA_HOME || path.join(os.homedir(), "Documents", "personal");
/** Remembers workspaces imported from outside BASE. */
const REGISTRY = path.join(os.homedir(), ".autojira", "imports.json");

export interface ProjectRow {
  id: string; // absolute workspace path
  name: string;
  updated_at: string;
}

const projectFile = (dir: string) => path.join(dir, ".autojira", "project.json");

function readRegistry(): string[] {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  } catch {
    return [];
  }
}

function writeRegistry(paths: string[]) {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify([...new Set(paths)], null, 2));
}

export function readProject(dir: string): Project | null {
  try {
    return JSON.parse(fs.readFileSync(projectFile(dir), "utf8"));
  } catch {
    return null;
  }
}

export function writeProject(dir: string, project: Project) {
  fs.mkdirSync(path.join(dir, ".autojira"), { recursive: true });
  fs.writeFileSync(projectFile(dir), JSON.stringify(project, null, 2));
}

function row(dir: string): ProjectRow | null {
  const p = readProject(dir);
  if (!p) return null;
  return {
    id: dir,
    name: p.name,
    updated_at: fs.statSync(projectFile(dir)).mtime.toISOString(),
  };
}

export function listProjects(): ProjectRow[] {
  const dirs = new Set<string>(readRegistry());
  if (fs.existsSync(BASE)) {
    for (const name of fs.readdirSync(BASE)) dirs.add(path.join(BASE, name));
  }
  return [...dirs]
    .map(row)
    .filter((r): r is ProjectRow => r !== null)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function createProject(name: string): ProjectRow {
  const safe = name.replace(/[/\\:]/g, "-").trim() || "untitled";
  const dir = path.join(BASE, safe);
  if (readProject(dir)) throw new Error(`"${safe}" already exists — import it instead`);
  writeProject(dir, defaultProject(name, dir));
  return row(dir)!;
}

/** Any folder works: adopts an existing .autojira, creates one otherwise. */
export function importProject(rawPath: string): ProjectRow {
  const dir = path.resolve(rawPath.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }
  if (!readProject(dir)) {
    writeProject(dir, defaultProject(path.basename(dir), dir));
  }
  if (path.dirname(dir) !== BASE) writeRegistry([...readRegistry(), dir]);
  return row(dir)!;
}

/** Forgets the project (removes .autojira); never touches the user's code. */
export function deleteProject(dir: string) {
  fs.rmSync(path.join(dir, ".autojira"), { recursive: true, force: true });
  writeRegistry(readRegistry().filter((p) => p !== dir));
}
