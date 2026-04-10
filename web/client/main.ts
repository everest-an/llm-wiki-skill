import mermaid from "mermaid";
import type { AuditEntry } from "audit-shared";
import { renderTree } from "./tree.js";
import { installFeedbackUI } from "./feedback.js";
import { renderGraph, type GraphData, type GraphNode } from "./graph.js";
import { ParticleField } from "./particles.js";

interface PageResponse {
  path: string;
  title: string | null;
  html: string;
  raw: string;
  frontmatter: Record<string, unknown> | null;
}

interface ConfigResponse {
  author?: string;
  wikiRoot?: string;
  defaultPage?: string | null;
}

type EdgeKind = "doc_wikilink" | "doc_markdown_link" | "code_import";

interface GraphFilters {
  edgeKinds: Set<EdgeKind>;
  nodeKind: "all" | "doc" | "code";
  topDir: string;
}

const state = {
  currentPath: "" as string,
  defaultPage: "wiki/index.md" as string,
  rawMarkdown: "" as string,
  author: "me" as string,
  graphTeardown: null as (() => void) | null,
};

// ── Mermaid with Catppuccin Mocha palette ──────────────────────────────────
mermaid.initialize({
  startOnLoad: false,
  theme: "base",
  securityLevel: "loose",
  fontFamily: "Inter, system-ui, sans-serif",
  themeVariables: {
    // canvas
    background: "#11111b",
    // nodes
    primaryColor: "#313244",
    primaryTextColor: "#cdd6f4",
    primaryBorderColor: "#b4befe",
    secondaryColor: "#45475a",
    secondaryTextColor: "#cdd6f4",
    secondaryBorderColor: "#89b4fa",
    tertiaryColor: "#585b70",
    tertiaryTextColor: "#cdd6f4",
    tertiaryBorderColor: "#94e2d5",
    // edges & text
    lineColor: "#7f849c",
    textColor: "#cdd6f4",
    mainBkg: "#313244",
    nodeBorder: "#b4befe",
    clusterBkg: "#181825",
    clusterBorder: "#45475a",
    titleColor: "#cdd6f4",
    edgeLabelBackground: "#181825",
    // sequence
    actorBkg: "#313244",
    actorBorder: "#b4befe",
    actorTextColor: "#cdd6f4",
    actorLineColor: "#7f849c",
    signalColor: "#cdd6f4",
    signalTextColor: "#cdd6f4",
    labelBoxBkgColor: "#313244",
    labelBoxBorderColor: "#b4befe",
    labelTextColor: "#cdd6f4",
    loopTextColor: "#cdd6f4",
    noteBkgColor: "#f9e2af",
    noteTextColor: "#11111b",
    noteBorderColor: "#f9e2af",
    activationBkgColor: "#45475a",
    activationBorderColor: "#b4befe",
    // state
    stateBkg: "#313244",
    stateBorder: "#b4befe",
    specialStateColor: "#f38ba8",
  },
});

async function main() {
  try {
    const cfg = (await fetch("/api/config").then((r) => r.json())) as ConfigResponse;
    if (cfg.author) state.author = cfg.author;
    if (cfg.defaultPage) state.defaultPage = cfg.defaultPage;
  } catch {}

  // Tree.
  const tree = await fetch("/api/tree").then((r) => r.json());
  renderTree(document.getElementById("tree")!, tree, (path) => {
    void loadPage(path);
    history.pushState({ page: path }, "", `/?page=${encodeURIComponent(path)}`);
  });

  // Initial page.
  const initial = new URL(window.location.href).searchParams.get("page") ?? state.defaultPage;
  await loadPage(initial);

  window.addEventListener("popstate", (e) => {
    const p = (e.state && e.state.page) || new URL(window.location.href).searchParams.get("page") || state.defaultPage;
    void loadPage(p);
  });

  // Intercept wikilinks so navigation stays in the SPA.
  document.getElementById("page-content")!.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest("a.wikilink") as HTMLAnchorElement | null;
    if (!target) return;
    const href = target.getAttribute("href") ?? "";
    const u = new URL(href, window.location.href);
    const page = u.searchParams.get("page");
    if (page) {
      e.preventDefault();
      void loadPage(page);
      history.pushState({ page }, "", `/?page=${encodeURIComponent(page)}`);
    }
  });

  // Refresh audits button.
  document.getElementById("btn-refresh")!.addEventListener("click", () => {
    void loadAudits(state.currentPath);
  });

  // Graph toggle.
  const graphOverlay = document.getElementById("graph-overlay")!;
  const openGraph = async () => {
    graphOverlay.classList.remove("hidden");
    // Let layout settle so canvas/svg get their sizes.
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const data = (await fetch("/api/graph").then((r) => r.json())) as GraphData;
    populateTopDirOptions(data);
    const filtered = filterGraphData(data, readGraphFilters());
    renderGraphStatus(data, filtered);
    const svg = document.getElementById("graph-svg") as unknown as SVGSVGElement;
    const canvas = document.getElementById("graph-particles") as HTMLCanvasElement;

    if (state.graphTeardown) state.graphTeardown();

    const particles = new ParticleField(canvas, 95);
    particles.start();

    const teardownGraph = renderGraph(svg, filtered, {
      onNodeClick: (node: GraphNode) => {
        closeGraph();
        void loadPage(node.path);
        history.pushState({ page: node.path }, "", `/?page=${encodeURIComponent(node.path)}`);
      },
    });

    state.graphTeardown = () => {
      particles.stop();
      teardownGraph();
    };
  };
  const closeGraph = () => {
    graphOverlay.classList.add("hidden");
    if (state.graphTeardown) {
      state.graphTeardown();
      state.graphTeardown = null;
    }
  };
  document.getElementById("btn-graph")!.addEventListener("click", () => {
    if (graphOverlay.classList.contains("hidden")) void openGraph();
    else closeGraph();
  });
  document.getElementById("graph-close")!.addEventListener("click", closeGraph);
  document.getElementById("graph-reset")!.addEventListener("click", () => {
    resetGraphFilters();
    void openGraph();
  });
  bindGraphFilterEvents(() => {
    if (graphOverlay.classList.contains("hidden")) return;
    void openGraph();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !graphOverlay.classList.contains("hidden")) {
      closeGraph();
    }
    if ((e.key === "g" || e.key === "G") && !isEditableFocused()) {
      e.preventDefault();
      if (graphOverlay.classList.contains("hidden")) void openGraph();
      else closeGraph();
    }
  });

  // Feedback UI.
  installFeedbackUI({
    getState: () => ({ currentPath: state.currentPath, rawMarkdown: state.rawMarkdown, author: state.author }),
    onCreated: async () => {
      await loadAudits(state.currentPath);
    },
  });
}

function isEditableFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}

async function loadPage(pathArg: string): Promise<void> {
  const pageEl = document.getElementById("page-content")!;
  pageEl.innerHTML = '<p class="loading">Loading</p>';

  try {
    const res = await fetch(`/api/page?path=${encodeURIComponent(pathArg)}`);
    if (!res.ok) {
      pageEl.innerHTML = `<p class="loading">Failed to load <code>${escapeHtml(pathArg)}</code>: ${res.status}</p>`;
      return;
    }
    const data: PageResponse = await res.json();
    state.currentPath = data.path;
    state.rawMarkdown = data.raw;

    pageEl.innerHTML = data.html;

    // Render mermaid blocks.
    const mermaidNodes = pageEl.querySelectorAll("pre.mermaid-block code.language-mermaid");
    for (let i = 0; i < mermaidNodes.length; i++) {
      const code = mermaidNodes[i] as HTMLElement;
      const pre = code.parentElement as HTMLElement;
      const source = code.textContent ?? "";
      const id = `mermaid-${Date.now()}-${i}`;
      try {
        const { svg } = await mermaid.render(id, source);
        const container = document.createElement("div");
        container.className = "mermaid-block";
        container.innerHTML = svg;
        const srcLine = pre.getAttribute("data-source-line");
        if (srcLine) container.setAttribute("data-source-line", srcLine);
        pre.replaceWith(container);
      } catch (err) {
        console.error("mermaid render failed", err);
      }
    }

    // Tree selection highlight.
    document.querySelectorAll("#tree a.active").forEach((el) => el.classList.remove("active"));
    const link = document.querySelector(`#tree a[data-path="${cssEscape(data.path)}"]`);
    if (link) link.classList.add("active");

    // Title chip.
    const titleEl = document.getElementById("wiki-title")!;
    titleEl.textContent = data.title ?? data.path;

    await loadAudits(data.path);
    pageEl.scrollTop = 0;
    (document.querySelector("main") as HTMLElement | null)?.scrollTo({ top: 0 });
  } catch (err) {
    console.error(err);
    pageEl.innerHTML = `<p class="loading">Error loading page.</p>`;
  }
}

async function loadAudits(targetPath: string): Promise<void> {
  const el = document.getElementById("audit-list")!;
  el.innerHTML = '<p class="loading">Loading</p>';
  try {
    const res = await fetch(`/api/audit?target=${encodeURIComponent(targetPath)}&mode=open`);
    const data: { entries: AuditEntry[] } = await res.json();
    if (data.entries.length === 0) {
      el.innerHTML = '<p class="muted" style="padding: 4px 6px; font-size: 12.5px;">No open audits for this page.</p>';
      return;
    }
    el.innerHTML = data.entries.map((e) => renderAuditItem(e)).join("");
    el.querySelectorAll("button[data-resolve]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-resolve")!;
        const note = window.prompt("Resolution note (optional):", "") ?? "";
        const r = await fetch(`/api/audit/${id}/resolve`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resolution: note }),
        });
        if (r.ok) await loadAudits(targetPath);
        else alert("Failed to resolve.");
      });
    });
  } catch (err) {
    el.innerHTML = '<p class="muted" style="padding: 4px 6px;">Failed to load audits.</p>';
    console.error(err);
  }
}

function renderAuditItem(e: AuditEntry): string {
  const body = e.body
    .replace(/^#\s*Comment\s*/i, "")
    .split(/^#\s*Resolution/im)[0]!
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  const when = new Date(e.created).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `
    <div class="audit-item sev-${e.severity}" data-id="${e.id}">
      <div class="audit-head">
        <span class="sev-pill sev-${e.severity}">${e.severity}</span>
        <span class="author">${escapeHtml(e.author)}</span>
      </div>
      <div class="audit-body">${escapeHtml(body)}</div>
      <div class="audit-meta">${e.id} · ${when}</div>
      <div class="audit-actions"><button type="button" data-resolve="${e.id}">mark resolved</button></div>
    </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch),
  );
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

function bindGraphFilterEvents(onChange: () => void): void {
  const ids = [
    "filter-edge-doc-wikilink",
    "filter-edge-doc-md",
    "filter-edge-code-import",
    "filter-node-kind",
    "filter-top-dir",
  ];
  for (const id of ids) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) continue;
    el.addEventListener("change", onChange);
  }
}

function resetGraphFilters(): void {
  setChecked("filter-edge-doc-wikilink", true);
  setChecked("filter-edge-doc-md", true);
  setChecked("filter-edge-code-import", true);
  setSelectValue("filter-node-kind", "all");
  setSelectValue("filter-top-dir", "all");
}

function setChecked(id: string, checked: boolean): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el) el.checked = checked;
}

function setSelectValue(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLSelectElement | null;
  if (el) el.value = value;
}

function readGraphFilters(): GraphFilters {
  const edgeKinds = new Set<EdgeKind>();
  if (isChecked("filter-edge-doc-wikilink")) edgeKinds.add("doc_wikilink");
  if (isChecked("filter-edge-doc-md")) edgeKinds.add("doc_markdown_link");
  if (isChecked("filter-edge-code-import")) edgeKinds.add("code_import");

  return {
    edgeKinds,
    nodeKind: (getSelectValue("filter-node-kind") as GraphFilters["nodeKind"]) || "all",
    topDir: getSelectValue("filter-top-dir") || "all",
  };
}

function isChecked(id: string): boolean {
  const el = document.getElementById(id) as HTMLInputElement | null;
  return !!el?.checked;
}

function getSelectValue(id: string): string {
  const el = document.getElementById(id) as HTMLSelectElement | null;
  return el?.value ?? "";
}

function populateTopDirOptions(data: GraphData): void {
  const select = document.getElementById("filter-top-dir") as HTMLSelectElement | null;
  if (!select) return;

  const prev = select.value || "all";
  const dirs = new Set<string>();
  for (const n of data.nodes) {
    const dir = getTopDir(n.path);
    if (dir) dirs.add(dir);
  }

  const sorted = Array.from(dirs).sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="all">all</option>';
  for (const d of sorted) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    select.appendChild(opt);
  }
  select.value = sorted.includes(prev) ? prev : "all";
}

function filterGraphData(data: GraphData, filters: GraphFilters): GraphData {
  const allowedNodeIds = new Set<string>();

  for (const n of data.nodes) {
    if (!matchNodeKind(n.path, filters.nodeKind)) continue;
    if (filters.topDir !== "all" && getTopDir(n.path) !== filters.topDir) continue;
    allowedNodeIds.add(n.id);
  }

  const filteredEdges = data.edges.filter((e) => {
    const s = typeof e.source === "string" ? e.source : e.source.id;
    const t = typeof e.target === "string" ? e.target : e.target.id;
    if (!allowedNodeIds.has(s) || !allowedNodeIds.has(t)) return false;
    if (!e.kind) return true;
    return filters.edgeKinds.has(e.kind as EdgeKind);
  });

  const connected = new Set<string>();
  for (const e of filteredEdges) {
    const s = typeof e.source === "string" ? e.source : e.source.id;
    const t = typeof e.target === "string" ? e.target : e.target.id;
    connected.add(s);
    connected.add(t);
  }

  const filteredNodes = data.nodes
    .filter((n) => allowedNodeIds.has(n.id))
    .filter((n) => connected.has(n.id))
    .map((n) => ({ ...n, degree: 0 }));

  const degree = new Map<string, number>();
  for (const e of filteredEdges) {
    const s = typeof e.source === "string" ? e.source : e.source.id;
    const t = typeof e.target === "string" ? e.target : e.target.id;
    degree.set(s, (degree.get(s) ?? 0) + 1);
    degree.set(t, (degree.get(t) ?? 0) + 1);
  }
  for (const n of filteredNodes) n.degree = degree.get(n.id) ?? 0;

  return { nodes: filteredNodes, edges: filteredEdges.map((e) => ({ ...e })) };
}

function matchNodeKind(p: string, kind: GraphFilters["nodeKind"]): boolean {
  if (kind === "all") return true;
  const isDoc = p.toLowerCase().endsWith(".md");
  return kind === "doc" ? isDoc : !isDoc;
}

function getTopDir(p: string): string {
  const normalized = p.startsWith("wiki/") ? p.slice(5) : p;
  if (!normalized.includes("/")) return "(root)";
  const seg = normalized.split("/")[0] ?? "";
  return seg.trim() || "(root)";
}

function renderGraphStatus(raw: GraphData, filtered: GraphData): void {
  const el = document.getElementById("graph-filter-status");
  if (!el) return;
  el.textContent = `${filtered.nodes.length}/${raw.nodes.length} nodes · ${filtered.edges.length}/${raw.edges.length} edges`;
}

void main();
