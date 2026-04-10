import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import type { ServerConfig } from "../config.js";
import { createRenderer } from "../render/markdown.js";

const FALLBACK_SKIP_DIRS = new Set([
  ".git",
  ".venv",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".pytest_cache",
  "__pycache__",
]);

export function handlePage(cfg: ServerConfig) {
  const renderer = createRenderer({ wikiRoot: cfg.wikiRoot });

  return (req: Request, res: Response) => {
    const relRaw = (req.query.path as string | undefined) ?? "";
    const rel = safeRel(relRaw, cfg.wikiRoot);
    if (!rel) {
      res.status(400).json({ error: "missing or invalid `path` query" });
      return;
    }

    // Default to wiki/index.md if a directory is requested.
    let full = path.join(cfg.wikiRoot, rel);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      full = path.join(full, "index.md");
    }

    if (!full.endsWith(".md")) full += ".md";

    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.status(404).json({ error: "file not found", path: rel });
      return;
    }

    // Guarantee the resolved path is still inside wikiRoot.
    const relFromRoot = path.relative(cfg.wikiRoot, full);
    if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
      res.status(403).json({ error: "path escapes wiki root" });
      return;
    }

    const rawMarkdown = fs.readFileSync(full, "utf-8");
    const rendered = renderer.render(rawMarkdown);
    res.json({
      path: relFromRoot.split(path.sep).join("/"),
      title: rendered.title,
      frontmatter: rendered.frontmatter,
      html: rendered.html,
      raw: rendered.rawMarkdown,
    });
  };
}

export function handleRaw(cfg: ServerConfig) {
  return (req: Request, res: Response) => {
    const relRaw = (req.query.path as string | undefined) ?? "";
    const rel = safeRel(relRaw, cfg.wikiRoot);
    if (!rel) {
      res.status(400).send("bad path");
      return;
    }
    const full = path.join(cfg.wikiRoot, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.status(404).send("not found");
      return;
    }
    res.type("text/markdown").send(fs.readFileSync(full));
  };
}

function safeRel(input: string, wikiRoot: string): string | null {
  if (!input) return findDefaultPagePath(wikiRoot);
  // Reject absolute and ..
  if (path.isAbsolute(input)) return null;
  const normalized = path.posix.normalize(input);
  if (normalized.startsWith("..")) return null;
  return normalized;
}

export function findDefaultPagePath(wikiRoot: string): string | null {
  const wikiIndex = path.join(wikiRoot, "wiki", "index.md");
  if (fs.existsSync(wikiIndex) && fs.statSync(wikiIndex).isFile()) return "wiki/index.md";

  const readme = path.join(wikiRoot, "README.md");
  if (fs.existsSync(readme) && fs.statSync(readme).isFile()) return "README.md";

  return findFirstMarkdown(wikiRoot, "");
}

function findFirstMarkdown(dir: string, rel: string): string | null {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => {
      if (e.name.startsWith(".")) return false;
      if (e.isDirectory() && FALLBACK_SKIP_DIRS.has(e.name)) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  for (const e of entries) {
    const childRel = rel ? path.posix.join(rel, e.name) : e.name;
    if (e.isFile() && e.name.endsWith(".md")) return childRel;
    if (e.isDirectory()) {
      const found = findFirstMarkdown(path.join(dir, e.name), childRel);
      if (found) return found;
    }
  }

  return null;
}
