"use strict";

// BrowserKey: finds AI provider API keys that reach the browser. UI layer only: all analysis
// lives in core.js. Secret values are never shown: findings carry only the documented key prefix.

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const core = require("./core");
const data = require("./data");

const SOURCE = "BrowserKey";
const VIEW_ID = "browserKey.view";
const CONTAINER_ID = "browserkey";
const FILE_GLOB = "**/{*.js,*.jsx,*.mjs,*.cjs,*.ts,*.tsx,*.mts,*.cts,*.vue,*.svelte,*.html,*.htm,*.yml,*.yaml,*.env,.env,.env.*,package.json,Dockerfile,Dockerfile.*,*.Dockerfile,Containerfile,netlify.toml}";
const MANDATORY_EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/vendor/**"];
const MAX_BYTES = 1024 * 1024;
const POLL_MS = 20000;
const ALLOWED_DOCS = new Set(Object.values(data.DOCS));

let diagnostics;
let treeView;
let treeProvider;
let statusBar;
/** uri string -> { uri, rel, findings, version } */
let results = new Map();
let mtimes = new Map();
let scanned = new Set();
let ctx = core.makeContext({});
let scanSeq = 0;
let fullScanTimer;
let pollTimer;
let polling = false;
const docTimers = new Map();

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

function readSettings() {
  const c = vscode.workspace.getConfiguration("browserKey");
  // In an untrusted workspace, every setting comes only from the user's own (global) value or the
  // default, never the repository's: a hostile repo can not turn BrowserKey off, silence rules,
  // cap the scan, exclude its own files or ignore its own names.
  const trusted = vscode.workspace.isTrusted;
  const get = (key) => {
    if (trusted) return c.get(key);
    const i = c.inspect(key) || {};
    return i.globalValue !== undefined ? i.globalValue : i.defaultValue;
  };
  const rawRules = get("rules");
  const severities = core.resolveSeverities(rawRules);
  let maxFiles = Number(get("maxFiles"));
  if (!Number.isFinite(maxFiles) || maxFiles < 1) maxFiles = 3000;
  const rawExclude = get("exclude");
  const rawIgnore = get("ignoreNames");
  const userExclude = Array.isArray(rawExclude) ? rawExclude.filter((g) => typeof g === "string") : [];
  const excludes = [...new Set([...MANDATORY_EXCLUDES, ...userExclude])];
  return {
    enabled: get("enabled") !== false,
    rawRules,
    severities,
    extraPublicPrefixes: core.sanitizePrefixes(get("extraPublicPrefixes")),
    ignoreNames: typeof rawIgnore === "string" ? rawIgnore : "",
    maxFiles: Math.min(Math.floor(maxFiles), 100000),
    excludes,
    isExcluded: core.makeExcluder(excludes),
  };
}

/**
 * findFiles exclude glob: only short, brace-free patterns that BrowserKey's own matcher accepts and
 * with few single "*" go to VS Code; everything is post-filtered by core.makeExcluder anyway.
 */
function findFilesExclude(s) {
  const simple = s.excludes.filter((g) => !/[{}]/.test(g) && core.globToRegExp(g) && (g.replace(/\*\*/g, "").match(/\*/g) || []).length <= 4);
  return simple.length ? `{${simple.join(",")}}` : null;
}

// ---------------------------------------------------------------------------------------------
// Workspace confinement
// ---------------------------------------------------------------------------------------------

function realpathOrNull(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (_) {
    return null;
  }
}

/** { rel, folderRel } for a file whose realpath is inside a workspace folder, else null. */
function confine(uri) {
  if (!(uri instanceof vscode.Uri) || uri.scheme !== "file") return null;
  const real = realpathOrNull(uri.fsPath);
  if (!real) return null;
  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    if (folder.uri.scheme !== "file") continue;
    const root = realpathOrNull(folder.uri.fsPath);
    if (!root) continue;
    const r = path.relative(root, real);
    if (r && !r.startsWith("..") && !path.isAbsolute(r)) {
      const shown = path.relative(folder.uri.fsPath, uri.fsPath);
      if (shown.startsWith("..") || path.isAbsolute(shown)) continue;
      const rel = shown.split(path.sep).join("/");
      return { rel: folders.length > 1 ? `${folder.name}/${rel}` : rel, folderRel: rel };
    }
  }
  return null;
}

function tabUris() {
  const out = [];
  for (const g of vscode.window.tabGroups.all) {
    for (const t of g.tabs) {
      if (t.input instanceof vscode.TabInputText && t.input.uri.scheme === "file") out.push(t.input.uri);
    }
  }
  return out;
}

function openDoc(uri) {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
}

async function readCapped(uri) {
  try {
    const st = await vscode.workspace.fs.stat(uri);
    if (st.size > MAX_BYTES || (st.type & vscode.FileType.File) === 0) return null;
    const buf = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder("utf-8").decode(buf);
    if (text.includes("\u0000")) return null;
    mtimes.set(uri.toString(), st.mtime);
    return text;
  } catch (_) {
    return null;
  }
}

async function textOf(uri) {
  const d = openDoc(uri);
  if (d) return d.getText().length > MAX_BYTES ? null : d.getText();
  return readCapped(uri);
}

const kindOf = (uri) => core.kindFromPath(uri.fsPath.split(path.sep).join("/"));
/** Files whose content changes the context for other files: rescan everything when they change. */
const isCrossFile = (uri) => {
  const k = kindOf(uri);
  return k === "package" || k === "env" || k === "ci" || k === "docker" || k === "compose" || k === "toml" || core.isContextFile(uri.fsPath);
};

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------

function analyzeText(uri, rel, text, s, version) {
  const rules = {};
  for (const id of core.RULE_IDS) rules[id] = s.severities[id] !== "off";
  const findings = core.analyze(text, rel, ctx, { rules });
  for (const f of findings) f.severity = core.findingSeverity(f, s.rawRules);
  return { uri, rel, findings, version };
}

function toSeverity(sev) {
  const S = vscode.DiagnosticSeverity;
  return sev === "error" ? S.Error : sev === "information" ? S.Information : sev === "hint" ? S.Hint : S.Warning;
}

function publish(fr) {
  const diags = fr.findings.map((f) => {
    const d = new vscode.Diagnostic(new vscode.Range(f.line, f.character, f.endLine, f.endCharacter), f.message, toSeverity(f.severity));
    d.source = SOURCE;
    d.code = f.rule;
    return d;
  });
  if (diags.length) diagnostics.set(fr.uri, diags);
  else diagnostics.delete(fr.uri);
}

function setResult(fr) {
  const key = fr.uri.toString();
  if (fr.findings.length) results.set(key, fr);
  else results.delete(key);
  publish(fr);
}

async function analyzeUri(uri) {
  const s = readSettings();
  if (!s.enabled) return;
  if (isCrossFile(uri)) {
    scheduleFullScan(300);
    return;
  }
  const info = confine(uri);
  const key = uri.toString();
  if (!info || s.isExcluded(info.folderRel) || !kindOf(uri)) {
    if (results.has(key)) {
      results.delete(key);
      diagnostics.delete(uri);
      refreshUi();
    }
    return;
  }
  if (!scanned.has(key)) {
    const inTab = tabUris().some((u) => u.toString() === key);
    if (!inTab && scanned.size >= s.maxFiles) return;
    scanned.add(key);
  }
  const d = openDoc(uri);
  const text = await textOf(uri);
  if (text === null) {
    results.delete(key);
    diagnostics.delete(uri);
  } else setResult(analyzeText(uri, info.rel, text, s, d ? d.version : undefined));
  refreshUi();
}

async function fullScan() {
  const seq = ++scanSeq;
  const s = readSettings();
  vscode.commands.executeCommand("setContext", "browserKey.enabled", s.enabled);
  if (!s.enabled) {
    results = new Map();
    diagnostics.clear();
    stopPolling();
    refreshUi();
    return;
  }
  const uris = await vscode.workspace.findFiles(FILE_GLOB, findFilesExclude(s), s.maxFiles);
  if (seq !== scanSeq) return;
  const seen = new Set(uris.map((u) => u.toString()));
  for (const u of tabUris()) {
    if (!seen.has(u.toString()) && kindOf(u)) {
      uris.push(u);
      seen.add(u.toString());
    }
  }
  // Read every confined, non-excluded file once.
  const files = [];
  for (const uri of uris) {
    const info = confine(uri);
    if (!info || s.isExcluded(info.folderRel) || !kindOf(uri)) continue;
    const text = await textOf(uri);
    if (seq !== scanSeq) return;
    if (text === null) continue;
    files.push({ uri, info, text, kind: kindOf(uri) });
  }
  // Phase 1: project context (frameworks from package.json, envPrefix / publicPrefix from configs).
  const packages = files.filter((f) => f.kind === "package").map((f) => ({ dir: path.posix.dirname(f.info.rel) === "." ? "" : path.posix.dirname(f.info.rel), text: f.text }));
  const configs = files.filter((f) => core.isContextFile(f.info.rel) && f.kind !== "package").map((f) => ({ rel: f.info.rel, text: f.text }));
  ctx = core.makeContext({ packages, configs, extraPublicPrefixes: s.extraPublicPrefixes, ignoreNames: s.ignoreNames });
  // Phase 2: .env, CI, Docker and compose files (they tell which public names hold AI key values).
  const next = new Map();
  const order = (f) => (f.kind === "js" || f.kind === "vue" || f.kind === "svelte" || f.kind === "html" ? 1 : 0);
  for (const f of files.slice().sort((a, b) => order(a) - order(b))) {
    if (f.kind === "package") continue;
    const d = openDoc(f.uri);
    const fr = analyzeText(f.uri, f.info.rel, f.text, s, d ? d.version : undefined);
    if (order(f) === 0) core.noteValueFindings(ctx, f.info.rel, fr.findings);
    if (fr.findings.length) next.set(f.uri.toString(), fr);
  }
  results = next;
  scanned = new Set(uris.map((u) => u.toString()));
  diagnostics.clear();
  for (const fr of results.values()) publish(fr);
  refreshUi();
  if (vscode.window.state.focused) startPolling();
}

function scheduleFullScan(ms) {
  clearTimeout(fullScanTimer);
  fullScanTimer = setTimeout(() => fullScan().catch(() => {}), ms);
}

function scheduleDoc(uri, ms) {
  const key = uri.toString();
  clearTimeout(docTimers.get(key));
  docTimers.set(key, setTimeout(() => {
    docTimers.delete(key);
    analyzeUri(uri).catch(() => {});
  }, ms));
}

// ---------------------------------------------------------------------------------------------
// Polling fallback (file watchers do not fire on every file system)
// ---------------------------------------------------------------------------------------------

async function pollOnce() {
  if (polling || !readSettings().enabled) return;
  polling = true;
  try {
    let cross = false;
    for (const key of [...scanned]) {
      const uri = vscode.Uri.parse(key);
      if (openDoc(uri)) continue;
      let st;
      try {
        st = await vscode.workspace.fs.stat(uri);
      } catch (_) {
        if (results.delete(key)) {
          diagnostics.delete(uri);
          refreshUi();
        }
        continue;
      }
      if (mtimes.has(key) && mtimes.get(key) !== st.mtime) {
        mtimes.set(key, st.mtime);
        if (isCrossFile(uri)) cross = true;
        else await analyzeUri(uri);
      }
    }
    if (cross) await fullScan();
  } finally {
    polling = false;
  }
}

function startPolling() {
  if (pollTimer || !readSettings().enabled) return;
  pollTimer = setInterval(() => {
    if (!vscode.window.state.focused) {
      stopPolling();
      return;
    }
    pollOnce().catch(() => {});
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}

// ---------------------------------------------------------------------------------------------
// Tree view, badge and status bar
// ---------------------------------------------------------------------------------------------

function allFindings() {
  const out = [];
  for (const fr of results.values()) for (const f of fr.findings) out.push(Object.assign({ rel: fr.rel, uri: fr.uri }, f));
  return out;
}

function refreshUi() {
  const s = readSettings();
  vscode.commands.executeCommand("setContext", "browserKey.enabled", s.enabled);
  const all = s.enabled ? allFindings() : [];
  const n = all.length;
  const errors = all.filter((f) => f.severity === "error").length;
  if (treeProvider) treeProvider.refresh();
  if (treeView) treeView.badge = n ? { value: n, tooltip: `${n} AI key exposure finding${n === 1 ? "" : "s"}` } : undefined;
  if (statusBar) {
    if (!s.enabled) statusBar.hide();
    else {
      statusBar.text = `$(key) BrowserKey: ${n}`;
      statusBar.tooltip = n ? `${n} AI key exposure finding${n === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"}). Click to open Browser key checks.` : "No AI API key reaches the browser. Click to open Browser key checks.";
      statusBar.show();
    }
  }
}

const ICONS = { error: ["error", "list.errorForeground"], warning: ["warning", "list.warningForeground"], information: ["info", "notificationsInfoIcon.foreground"], hint: ["lightbulb", "notificationsInfoIcon.foreground"] };

class KeyTreeProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
  }
  refresh() {
    this._emitter.fire();
  }
  dispose() {
    this._emitter.dispose();
  }
  getChildren(node) {
    if (!readSettings().enabled) return [];
    if (!node) return [...results.values()].sort((a, b) => a.rel.localeCompare(b.rel)).map((fr) => ({ type: "file", key: fr.uri.toString() }));
    if (node.type === "file") {
      const fr = results.get(node.key);
      return fr ? fr.findings.map((f) => ({ type: "finding", key: node.key, id: f.id })) : [];
    }
    return [];
  }
  getTreeItem(node) {
    const C = vscode.TreeItemCollapsibleState;
    const fr = results.get(node.key);
    if (!fr) return new vscode.TreeItem("(stale)", C.None);
    if (node.type === "file") {
      const item = new vscode.TreeItem(path.posix.basename(fr.rel), C.Expanded);
      const dir = path.posix.dirname(fr.rel);
      item.description = `${dir === "." ? "" : dir + "  "}${fr.findings.length}`;
      item.resourceUri = fr.uri;
      item.iconPath = vscode.ThemeIcon.File;
      item.tooltip = `${fr.rel}\n${fr.findings.length} finding${fr.findings.length === 1 ? "" : "s"}`;
      item.contextValue = "file";
      item.id = "file:" + node.key;
      return item;
    }
    const f = fr.findings.find((x) => x.id === node.id);
    if (!f) return new vscode.TreeItem("(stale)", C.None);
    const item = new vscode.TreeItem(f.short, C.None);
    item.description = `${f.rule}  :${f.line + 1}`;
    const [icon, color] = ICONS[f.severity] || ICONS.warning;
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.tooltip = `${f.rule} ${core.RULES[f.rule].title}\n${fr.rel}:${f.line + 1}\n\n${f.message}${f.fix ? "\n\nQuick Fix: " + f.fix.title : ""}`;
    item.contextValue = f.fix ? "finding.fixable" : "finding";
    item.id = `finding:${node.key}:${f.id}`;
    item.command = { command: "browserKey.openFinding", title: "Go to finding", arguments: [fr.uri, f.line, f.character] };
    return item;
  }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

async function openFindingCmd(uri, line, character) {
  const fr = uri instanceof vscode.Uri ? results.get(uri.toString()) : undefined;
  const n = Number(line);
  const ch = Number(character);
  const f = fr && Number.isInteger(n) ? fr.findings.find((x) => x.line === n) : undefined;
  if (!fr || !f || !confine(uri)) {
    vscode.window.showWarningMessage("BrowserKey: refusing to open something that is not a current finding inside the workspace.");
    return false;
  }
  const doc = await vscode.workspace.openTextDocument(fr.uri);
  const ed = await vscode.window.showTextDocument(doc, { preview: true });
  const pos = new vscode.Position(Math.min(n, doc.lineCount - 1), Number.isInteger(ch) && ch >= 0 ? ch : 0);
  ed.selection = new vscode.Selection(pos, pos);
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  return true;
}

function findingForNode(node) {
  if (!node || typeof node !== "object" || node.type !== "finding" || typeof node.key !== "string" || typeof node.id !== "string") return null;
  const fr = results.get(node.key);
  if (!fr) return null;
  const f = fr.findings.find((x) => x.id === node.id);
  return f ? { fr, f } : null;
}

function fixEdit(doc, f) {
  const edit = new vscode.WorkspaceEdit();
  for (const e of f.fix.edits) {
    const range = new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end));
    if (doc.getText(range) !== e.expect) return null;
    edit.replace(doc.uri, range, e.text);
  }
  return edit;
}

async function applyFixCmd(node) {
  const hit = findingForNode(node);
  if (!hit || !hit.f.fix || !confine(hit.fr.uri)) {
    vscode.window.showWarningMessage("BrowserKey: that finding is no longer current.");
    return false;
  }
  const { fr, f } = hit;
  const doc = await vscode.workspace.openTextDocument(fr.uri);
  const edit = fixEdit(doc, f);
  if (!edit) {
    await fullScan();
    vscode.window.showWarningMessage("BrowserKey: the file changed since it was checked; rescanned, try again.");
    return false;
  }
  const ok = await vscode.workspace.applyEdit(edit);
  if (ok) {
    const ed = await vscode.window.showTextDocument(doc, { preview: true });
    const pos = doc.positionAt(f.fix.edits[0].start);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    await fullScan();
  }
  return ok;
}

/** The documentation link of a live finding, only when it is one of BrowserKey's own references. */
function referenceFor(node) {
  const hit = findingForNode(node);
  return hit && ALLOWED_DOCS.has(hit.f.docUrl) ? hit.f.docUrl : null;
}

async function openReferenceCmd(node) {
  const url = referenceFor(node);
  if (!url) {
    vscode.window.showWarningMessage("BrowserKey: that finding is no longer current.");
    return false;
  }
  return vscode.env.openExternal(vscode.Uri.parse(url));
}

// ---------------------------------------------------------------------------------------------
// Quick Fixes and documentation actions
// ---------------------------------------------------------------------------------------------

class FixProvider {
  provideCodeActions(doc, _range, context) {
    const fr = results.get(doc.uri.toString());
    if (!fr || (fr.version !== undefined && fr.version !== doc.version)) return [];
    const out = [];
    for (const diag of context.diagnostics) {
      if (diag.source !== SOURCE) continue;
      const f = fr.findings.find((x) => x.rule === diag.code && x.message === diag.message && x.line === diag.range.start.line && x.character === diag.range.start.character);
      if (!f) continue;
      if (f.fix) {
        const edit = fixEdit(doc, f);
        if (edit) {
          const action = new vscode.CodeAction(`${f.fix.title} (${f.rule})`, vscode.CodeActionKind.QuickFix);
          action.diagnostics = [diag];
          action.isPreferred = true;
          action.edit = edit;
          out.push(action);
        }
      }
      if (ALLOWED_DOCS.has(f.docUrl)) {
        const docAction = new vscode.CodeAction(`Open docs: how to keep this key on the server (${f.rule})`, vscode.CodeActionKind.QuickFix);
        docAction.diagnostics = [diag];
        docAction.command = { command: "browserKey.openReference", title: "Open docs", arguments: [{ type: "finding", key: fr.uri.toString(), id: f.id }] };
        out.push(docAction);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------------------------

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection("browserkey");
  treeProvider = new KeyTreeProvider();
  treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: treeProvider, showCollapseAll: true });
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = "browserKey.focusView";
  statusBar.name = "BrowserKey";

  const watcher = vscode.workspace.createFileSystemWatcher(FILE_GLOB);
  const onDisk = (uri) => {
    if (uri.scheme === "file" && kindOf(uri) && !openDoc(uri)) scheduleDoc(uri, 300);
  };
  const relevant = (d) => d.uri.scheme === "file" && !!kindOf(d.uri);

  context.subscriptions.push(
    diagnostics,
    treeProvider,
    treeView,
    statusBar,
    watcher,
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new FixProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand("browserKey.rescan", () => fullScan()),
    vscode.commands.registerCommand("browserKey.openFinding", (uri, line, character) => openFindingCmd(uri, line, character)),
    vscode.commands.registerCommand("browserKey.applyFix", (node) => applyFixCmd(node)),
    vscode.commands.registerCommand("browserKey.openReference", (node) => openReferenceCmd(node)),
    vscode.commands.registerCommand("browserKey.focusView", () => vscode.commands.executeCommand(`workbench.view.extension.${CONTAINER_ID}`)),
    vscode.commands.registerCommand("browserKey.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "browserKey")),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (relevant(e.document) && e.contentChanges.length) scheduleDoc(e.document.uri, 250);
    }),
    vscode.workspace.onDidOpenTextDocument((d) => {
      if (relevant(d) && !isCrossFile(d.uri)) scheduleDoc(d.uri, 50);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      if (relevant(d)) scheduleDoc(d.uri, 100);
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (relevant(d)) scheduleDoc(d.uri, 50);
    }),
    watcher.onDidCreate(onDisk),
    watcher.onDidChange(onDisk),
    watcher.onDidDelete((uri) => {
      if (isCrossFile(uri)) scheduleFullScan(300);
      else if (results.delete(uri.toString())) {
        diagnostics.delete(uri);
        refreshUi();
      }
    }),
    vscode.window.onDidChangeWindowState((st) => {
      if (st.focused) {
        startPolling();
        pollOnce().catch(() => {});
      } else stopPolling();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("browserKey")) scheduleFullScan(50);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleFullScan(200)),
    vscode.workspace.onDidGrantWorkspaceTrust(() => scheduleFullScan(200)),
    { dispose: () => { clearTimeout(fullScanTimer); stopPolling(); for (const t of docTimers.values()) clearTimeout(t); } }
  );

  refreshUi();
  const ready = fullScan().catch(() => {});

  // Small API used by the in-editor tests.
  return {
    ready: () => ready,
    rescan: () => fullScan(),
    poll: () => pollOnce(),
    getFindings: () => allFindings(),
    getTreeItems: async (node) => {
      const out = [];
      for (const child of treeProvider.getChildren(node)) out.push(Object.assign({ node: child }, treeProvider.getTreeItem(child)));
      return out;
    },
    referenceFor: (node) => referenceFor(node),
    getBadge: () => (treeView && treeView.badge ? treeView.badge.value : 0),
    getStatusText: () => (statusBar ? statusBar.text : ""),
  };
}

function deactivate() {}

module.exports = { activate, deactivate };
