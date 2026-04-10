import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import type { ServerConfig } from "../config.js";

export interface TreeNode {
  name: string;
  path: string; // relative to wikiRoot
  kind: "file" | "dir";
  children?: TreeNode[];
}

const SKIP_DIRS = new Set([
  ".git",
  ".venv",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".pytest_cache",
  "__pycache__",
]);

/**
 * Build a navigation tree from the wiki/ directory.
 * The tree is recursive, sorted alphabetically, and only includes .md files.
 */
export function buildTree(wikiRoot: string): TreeNode {
  const wikiDir = path.join(wikiRoot, "wiki");
  if (fs.existsSync(wikiDir) && fs.statSync(wikiDir).isDirectory()) {
    return walk(wikiDir, "wiki");
  }

  // Fallback for non-llm-wiki repos: build a tree from the root markdown files.
  return walk(wikiRoot, "");
}

function walk(dir: string, rel: string): TreeNode {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => {
      if (e.name.startsWith(".")) return false;
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const children: TreeNode[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const nodeRel = rel ? path.posix.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      const child = walk(full, nodeRel);
      if ((child.children ?? []).length > 0) children.push(child);
    } else if (e.name.endsWith(".md")) {
      children.push({ name: e.name.replace(/\.md$/, ""), path: nodeRel, kind: "file" });
    }
  }

  return { name: rel ? path.basename(dir) : "root", path: rel, kind: "dir", children };
}

export function handleTree(cfg: ServerConfig) {
  return (_req: Request, res: Response) => {
    res.json(buildTree(cfg.wikiRoot));
  };
}
