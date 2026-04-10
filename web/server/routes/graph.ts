import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import type { ServerConfig } from "../config.js";

export interface GraphNode {
  id: string; // path relative to wikiRoot, e.g. "wiki/concepts/Transformers.md"
  label: string; // display name (stem, e.g. "Transformers")
  path: string; // same as id, kept explicit for client
  group: string; // concepts | entities | summaries | other
  degree: number; // in + out link count, used for node sizing
  title: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: "doc_wikilink" | "doc_markdown_link" | "code_import";
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const MD_LINK_RE = /\[[^\]]+\]\(([^)]+)\)/g;
const IMPORT_FROM_RE = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g;
const CODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py"];
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

export function buildGraph(wikiRoot: string): GraphData {
  const wikiDir = path.join(wikiRoot, "wiki");
  const hasWikiDir = fs.existsSync(wikiDir) && fs.statSync(wikiDir).isDirectory();
  const baseDir = hasWikiDir ? wikiDir : wikiRoot;
  const pathPrefix = hasWikiDir ? "wiki/" : "";

  const markdownFiles = collectMdFiles(baseDir);
  const codeFiles = collectCodeFiles(baseDir);
  const markdownFileSet = new Set(markdownFiles.map((f) => toPosix(path.relative(baseDir, f))));
  const codeFileSet = new Set(codeFiles.map((f) => toPosix(path.relative(baseDir, f))));

  // Build a lookup table keyed by both the stem ("Transformers") and the
  // relative-to-wiki path (e.g. "concepts/Transformers"), so wikilinks can
  // resolve in either form.
  const byKey: Map<string, string> = new Map(); // key → rel-from-wikiRoot path
  const nodes: Map<string, GraphNode> = new Map();

  for (const f of markdownFiles) {
    const relFromBase = path.relative(baseDir, f).split(path.sep).join("/");
    const id = `${pathPrefix}${relFromBase}`;
    const stem = path.basename(f, ".md");
    const parts = relFromBase.split("/");
    const group = parts.length > 1 ? parts[0]! : "other";
    const title = extractTitle(fs.readFileSync(f, "utf-8")) ?? stem;

    const node: GraphNode = {
      id,
      label: stem,
      path: id,
      group,
      degree: 0,
      title,
    };
    nodes.set(id, node);
    byKey.set(stem, id);
    byKey.set(relFromBase.replace(/\.md$/, ""), id);
    // Also index by basename without extension in lowercase as a last-resort alias
    byKey.set(stem.toLowerCase(), id);
  }

  // Add code nodes so architecture relationships can be visualized.
  for (const f of codeFiles) {
    const relFromBase = toPosix(path.relative(baseDir, f));
    const id = `${pathPrefix}${relFromBase}`;
    const stem = path.basename(f, path.extname(f));
    const parts = relFromBase.split("/");
    const group = parts.length > 1 ? parts[0]! : "code";

    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        label: stem,
        path: id,
        group,
        degree: 0,
        title: relFromBase,
      });
    }
  }

  // Pass 2: build edges. Parse wikilinks per file and resolve targets.
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  for (const f of markdownFiles) {
    const relFromBase = path.relative(baseDir, f).split(path.sep).join("/");
    const srcId = `${pathPrefix}${relFromBase}`;
    const text = fs.readFileSync(f, "utf-8");
    WIKILINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_RE.exec(text))) {
      const target = m[1]!.trim();
      if (target.startsWith("#")) continue; // anchor-only links — ignore
      const tgtId =
        byKey.get(target) ??
        byKey.get(target.replace(/\.md$/, "")) ??
        byKey.get(target.toLowerCase());
      if (!tgtId || tgtId === srcId) continue;

      const key = `${srcId}→${tgtId}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ source: srcId, target: tgtId, kind: "doc_wikilink" });

      nodes.get(srcId)!.degree += 1;
      nodes.get(tgtId)!.degree += 1;
    }

    MD_LINK_RE.lastIndex = 0;
    while ((m = MD_LINK_RE.exec(text))) {
      const href = (m[1] ?? "").trim();
      const targetRel = resolveMarkdownLink(relFromBase, href, markdownFileSet);
      if (!targetRel) continue;
      const tgtId = `${pathPrefix}${targetRel}`;
      if (!nodes.has(tgtId) || tgtId === srcId) continue;

      const key = `${srcId}→${tgtId}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ source: srcId, target: tgtId, kind: "doc_markdown_link" });

      nodes.get(srcId)!.degree += 1;
      nodes.get(tgtId)!.degree += 1;
    }
  }

  // Pass 3: add code dependency edges (relative imports/requires).
  for (const f of codeFiles) {
    const srcRel = toPosix(path.relative(baseDir, f));
    const srcId = `${pathPrefix}${srcRel}`;
    const text = fs.readFileSync(f, "utf-8");
    const specs = extractImportSpecifiers(text);

    for (const spec of specs) {
      const resolvedRel = resolveCodeImport(srcRel, spec, codeFileSet);
      if (!resolvedRel) continue;
      const tgtId = `${pathPrefix}${resolvedRel}`;
      if (tgtId === srcId || !nodes.has(tgtId)) continue;

      const key = `${srcId}→${tgtId}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ source: srcId, target: tgtId, kind: "code_import" });

      nodes.get(srcId)!.degree += 1;
      nodes.get(tgtId)!.degree += 1;
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges,
  };
}

function collectMdFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectMdFiles(full));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function collectCodeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...collectCodeFiles(full));
      continue;
    }
    if (!e.isFile()) continue;
    if (CODE_EXTS.includes(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

function extractImportSpecifiers(text: string): string[] {
  const out = new Set<string>();

  IMPORT_FROM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_FROM_RE.exec(text))) {
    const spec = m[1]?.trim();
    if (spec) out.add(spec);
  }

  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(text))) {
    const spec = m[1]?.trim();
    if (spec) out.add(spec);
  }

  return Array.from(out);
}

function resolveCodeImport(fromRel: string, spec: string, codeFileSet: Set<string>): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;

  const fromDir = path.posix.dirname(fromRel);
  const base = path.posix.normalize(path.posix.join(fromDir, spec));
  if (base.startsWith("..")) return null;

  const candidates = new Set<string>([base]);
  for (const ext of CODE_EXTS) candidates.add(`${base}${ext}`);
  for (const ext of CODE_EXTS) candidates.add(path.posix.join(base, `index${ext}`));
  candidates.add(path.posix.join(base, "__init__.py"));

  for (const c of candidates) {
    if (codeFileSet.has(c)) return c;
  }
  return null;
}

function resolveMarkdownLink(
  fromRel: string,
  hrefRaw: string,
  markdownFileSet: Set<string>,
): string | null {
  const href = hrefRaw.split("#")[0]?.trim() ?? "";
  if (!href) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return null;
  if (href.startsWith("/")) return null;

  const fromDir = path.posix.dirname(fromRel);
  const decoded = safeDecodeUri(href);
  const base = path.posix.normalize(path.posix.join(fromDir, decoded));
  if (base.startsWith("..")) return null;

  const candidates = new Set<string>([base]);
  if (!base.endsWith(".md")) candidates.add(`${base}.md`);
  candidates.add(path.posix.join(base, "index.md"));

  for (const c of candidates) {
    if (markdownFileSet.has(c)) return c;
  }
  return null;
}

function safeDecodeUri(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function extractTitle(text: string): string | null {
  // frontmatter title
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (fm) {
    const t = /^title:\s*(.+)$/m.exec(fm[1]!);
    if (t) return t[1]!.trim().replace(/^["']|["']$/g, "");
  }
  const h1 = /^#\s+(.+?)\s*$/m.exec(text);
  return h1 ? h1[1]! : null;
}

export function handleGraph(cfg: ServerConfig) {
  return (_req: Request, res: Response) => {
    res.json(buildGraph(cfg.wikiRoot));
  };
}
