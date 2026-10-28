"use strict";

// In-editor test, loaded by VS Code through --extensionTestsPath. Expects the workspace built by
// test/run-vscode.js and its JSON config in BK_TEST_CONFIG.

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const fx = require("../fixtures");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? undefined : detail });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_) {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error("timeout waiting for " + label);
}
async function expectWait(name, fn, timeoutMs) {
  try {
    await waitFor(fn, timeoutMs || 15000, name);
    check(name, true);
  } catch (e) {
    check(name, false, String(e));
  }
}

async function run() {
  const cfg = JSON.parse(fs.readFileSync(process.env.BK_TEST_CONFIG, "utf8"));
  const { mode, root, outsideDir, resultFile, markerDir } = cfg;
  const trusted = mode === "trusted";
  const M = (s) => `${mode}: ${s}`;
  const P = (rel) => path.join(root, ...rel.split("/"));
  const EXPECT = [...fx.EXPECT, ...fx.EXTRA_EXPECT];
  const TOTAL = EXPECT.length;
  const conf = () => vscode.workspace.getConfiguration("browserKey");
  const sig = (f) => [f.rel, f.rule, f.rule === "BK003" || f.rule === "BK006" ? null : f.name, f.line].join("|");
  const keys = Object.values(fx.KEYS);

  try {
    check(M("workspace trust state"), vscode.workspace.isTrusted === trusted);
    const ext = vscode.extensions.getExtension("jaytankdev.browserkey");
    check(M("extension found"), !!ext);
    const api = ext.isActive ? ext.exports : await ext.activate();
    check(M("activate() returns the test API"), api && typeof api.getTreeItems === "function");
    await api.ready();
    await expectWait(M(`initial scan finds ${TOTAL} findings`), () => api.getFindings().length === TOTAL, 30000);
    const F = api.getFindings();
    const got = new Set(F.map(sig));
    for (const e of EXPECT) check(M(`finding ${e.join(" ")}`), got.has(e.join("|")), JSON.stringify(F.filter((f) => f.rel === e[0]).map(sig)));
    const want = new Set(EXPECT.map((e) => e.join("|")));
    check(M("no unexpected findings"), F.every((f) => want.has(sig(f))), JSON.stringify(F.filter((f) => !want.has(sig(f))).map(sig)));
    for (const rel of ["clean/firebase.tsx", "clean/.env.example", "apps/web/app/api/chat/route.ts", "apps/api/src/index.ts", "apps/kit/src/routes/+page.server.ts", "node_modules/pkg/.env", "node_modules/pkg/index.tsx", "dist/app.js", "big.tsx", "link.tsx", "linked.env", "live/live.tsx"]) {
      check(M(`no findings in ${rel}`), !F.some((f) => f.rel === rel));
    }
    check(M("nothing reported outside the workspace"), !F.some((f) => f.uri.fsPath.startsWith(outsideDir)));
    const allText = F.map((f) => f.short + f.message + (f.name || "")).join("\n");
    check(M("no key value appears in any finding"), keys.every((k) => !allText.includes(k.slice(-16))));

    // Contributions.
    const pkg = ext.packageJSON;
    const ac = (pkg.contributes.viewsContainers || {}).activitybar || [];
    check(M("activity bar container contributed"), ac.some((c) => c.id === "browserkey" && c.icon === "media/activity.svg"));
    check(M("activity bar icon file exists"), fs.existsSync(path.join(ext.extensionPath, "media", "activity.svg")));
    check(M("view named Browser key checks"), (pkg.contributes.views.browserkey || []).some((v) => v.id === "browserKey.view" && v.name === "Browser key checks"));
    check(M("inline Quick Fix and docs buttons contributed"), pkg.contributes.menus["view/item/context"].filter((m) => m.group.startsWith("inline")).length === 2);
    check(M("three empty states contributed"), pkg.contributes.viewsWelcome.length === 3);
    check(M("untrustedWorkspaces supported: true"), pkg.capabilities.untrustedWorkspaces.supported === true);

    // Diagnostics, badge, status bar.
    const page = vscode.Uri.file(P("apps/web/app/chat/page.tsx"));
    const diag = vscode.languages.getDiagnostics(page).filter((d) => d.source === "BrowserKey");
    check(M("diagnostics published for page.tsx"), diag.length === 4, String(diag.length));
    check(M("BK002 is an error"), diag.some((d) => d.code === "BK002" && d.severity === vscode.DiagnosticSeverity.Error));
    check(M("BK004 is a warning"), diag.some((d) => d.code === "BK004" && d.severity === vscode.DiagnosticSeverity.Warning));
    check(M("diagnostic range covers the variable name"), diag.some((d) => d.code === "BK002" && d.range.start.line === 3 && d.range.start.character === 22 && d.range.end.character === 22 + "NEXT_PUBLIC_OPENAI_API_KEY".length));
    const byok = vscode.languages.getDiagnostics(vscode.Uri.file(P("apps/spa/src/byok.ts"))).filter((d) => d.source === "BrowserKey");
    check(M("BK003 with a user-supplied key is information"), byok.length === 1 && byok[0].severity === vscode.DiagnosticSeverity.Information);
    const envDiag = vscode.languages.getDiagnostics(vscode.Uri.file(P("apps/web/.env.local"))).filter((d) => d.source === "BrowserKey");
    check(M("diagnostics on .env.local, values masked"), envDiag.length === 2 && envDiag.every((d) => keys.every((k) => !d.message.includes(k.slice(-16)))));
    check(M("no diagnostics for excluded node_modules"), vscode.languages.getDiagnostics(vscode.Uri.file(P("node_modules/pkg/.env"))).length === 0);
    check(M("badge equals finding count"), api.getBadge() === TOTAL, `badge=${api.getBadge()}`);
    check(M("status bar shows BrowserKey: N"), api.getStatusText().endsWith(`BrowserKey: ${TOTAL}`), api.getStatusText());

    let opened = true;
    try {
      await vscode.commands.executeCommand("workbench.view.extension.browserkey");
      await vscode.commands.executeCommand("browserKey.focusView");
    } catch (e) {
      opened = String(e);
    }
    check(M("view container and focusView open"), opened === true, opened);

    // Tree rows.
    const top = await api.getTreeItems();
    const filesWithFindings = new Set(EXPECT.map((e) => e[0]));
    check(M("one row per file with findings"), top.length === filesWithFindings.size && top.every((t) => t.contextValue === "file"), JSON.stringify(top.map((t) => t.label)));
    const envRow = top.find((t) => t.resourceUri && t.resourceUri.fsPath === P("apps/web/.env.local"));
    check(M("file row: name, folder and count"), envRow && envRow.label === ".env.local" && envRow.description === "apps/web  2", envRow && JSON.stringify([envRow.label, envRow.description]));
    const envRows = await api.getTreeItems(envRow.node);
    check(M("row label names the variable and the file"), envRows.some((r) => r.label === "NEXT_PUBLIC_OPENAI_API_KEY in .env.local is bundled into the browser" && r.description === "BK001  :2"), JSON.stringify(envRows.map((r) => [r.label, r.description])));
    const pageRow = top.find((t) => t.resourceUri && t.resourceUri.fsPath === page.fsPath);
    const pageRows = await api.getTreeItems(pageRow.node);
    const labels = pageRows.map((r) => r.label);
    check(M("page.tsx rows name exact things"), labels.includes("NEXT_PUBLIC_OPENAI_API_KEY read in client code is shipped to the browser") && labels.includes("new OpenAI({ dangerouslyAllowBrowser: true }) exposes the API key") && labels.includes('server-only ANTHROPIC_API_KEY read in a "use client" component'), JSON.stringify(labels));
    check(M("rows have icon, tooltip with file:line, open command"), pageRows.every((r) => r.iconPath && /apps\/web\/app\/chat\/page\.tsx:\d+/.test(r.tooltip) && r.command && r.command.command === "browserKey.openFinding"));
    check(M("fixable rows marked for the inline button"), envRows.some((r) => r.contextValue === "finding.fixable") && pageRows.every((r) => r.contextValue === "finding"));
    check(M("docs link for every row is a known reference"), pageRows.every((r) => /^https:\/\//.test(api.referenceFor(r.node) || "")));
    check(M("BK003 row links to the OpenAI SDK README"), api.referenceFor(pageRows.find((r) => r.label.startsWith("new OpenAI")).node) === "https://github.com/openai/openai-node#requirements");
    const keysRow = top.find((t) => t.resourceUri && t.resourceUri.fsPath === P("apps/spa/src/keys.ts"));
    const k6 = (await api.getTreeItems(keysRow.node))[0];
    check(M("BK006 row is masked"), k6.label === "hardcoded Groq key gsk_**** in browser code" && keys.every((k) => !k6.tooltip.includes(k.slice(-16))), k6.label);

    // Open a finding.
    const r0 = pageRows.find((r) => r.label.startsWith("server-only"));
    const [uri, line, ch] = r0.command.arguments;
    const ok = await vscode.commands.executeCommand("browserKey.openFinding", uri, line, ch);
    const ed = vscode.window.activeTextEditor;
    check(M("openFinding opens the file at the line"), ok === true && ed && ed.document.uri.fsPath === page.fsPath && ed.selection.active.line === 7);
    const weirdRow = top.find((t) => t.resourceUri && t.resourceUri.fsPath === P("weird dir/naïve file (1).tsx"));
    const wr = (await api.getTreeItems(weirdRow.node))[0];
    check(M("openFinding opens the weird-named file"), (await vscode.commands.executeCommand("browserKey.openFinding", ...wr.command.arguments)) === true);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // Forged arguments.
    check(M("openFinding refuses a plain object"), (await vscode.commands.executeCommand("browserKey.openFinding", { fsPath: page.fsPath, scheme: "file" }, 7)) === false);
    check(M("openFinding refuses a file outside the workspace"), (await vscode.commands.executeCommand("browserKey.openFinding", vscode.Uri.file(path.join(outsideDir, "evil.tsx")), 1)) === false);
    check(M("openFinding refuses a symlink leading outside"), (await vscode.commands.executeCommand("browserKey.openFinding", vscode.Uri.file(P("link.tsx")), 1)) === false);
    check(M("openFinding refuses a line without a finding"), (await vscode.commands.executeCommand("browserKey.openFinding", uri, 999)) === false);
    check(M("no editor opened for refused arguments"), !vscode.window.activeTextEditor);
    check(M("applyFix refuses a forged node"), (await vscode.commands.executeCommand("browserKey.applyFix", { type: "finding", key: uri.toString(), id: "BK001:0" })) === false);
    check(M("applyFix refuses a non-fixable finding"), (await vscode.commands.executeCommand("browserKey.applyFix", r0.node)) === false);
    check(M("applyFix refuses junk"), (await vscode.commands.executeCommand("browserKey.applyFix", "x")) === false);
    check(M("openReference refuses a forged node"), (await vscode.commands.executeCommand("browserKey.openReference", { type: "finding", key: "file:///etc/passwd", id: "x" })) === false);
    check(M("openReference refuses junk"), (await vscode.commands.executeCommand("browserKey.openReference", 42)) === false);

    // Screenshot (trusted run).
    if (trusted) {
      const pdoc = await vscode.workspace.openTextDocument(page);
      await vscode.window.showTextDocument(pdoc, { preview: false });
      await vscode.commands.executeCommand("browserKey.openFinding", ...pageRows[0].command.arguments);
      await vscode.commands.executeCommand("workbench.view.extension.browserkey");
      for (const cmd of ["workbench.action.closeAuxiliaryBar", "notifications.clearAll", "workbench.action.closePanel"]) {
        try {
          await vscode.commands.executeCommand(cmd);
        } catch (_) {
          /* not available */
        }
      }
      await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
      for (let i = 0; i < 13; i++) {
        try {
          await vscode.commands.executeCommand("workbench.action.decreaseViewWidth");
        } catch (_) {
          break;
        }
      }
      await sleep(6000);
      fs.writeFileSync(path.join(markerDir, "shot-" + mode), "1");
      await expectWait(M("screenshot taken"), () => fs.existsSync(path.join(markerDir, "shot-done-" + mode)), 40000);
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // Quick Fix through the code action provider: rename NEXT_PUBLIC_ASSIST in .env.local.
    const edoc = await vscode.workspace.openTextDocument(P("apps/web/.env.local"));
    await vscode.window.showTextDocument(edoc);
    await sleep(800);
    const acts = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", edoc.uri, new vscode.Range(2, 0, 2, 5), vscode.CodeActionKind.QuickFix.value);
    const titles = (acts || []).map((a) => a.title);
    const rename = (acts || []).find((a) => a.title === "Rename to ASSIST (server-only) (BK001)");
    check(M("rename Quick Fix offered"), !!rename, JSON.stringify(titles));
    check(M("docs action offered"), titles.some((t) => /^Open docs: .*\(BK001\)$/.test(t)), JSON.stringify(titles));
    const acts1 = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", edoc.uri, new vscode.Range(1, 0, 1, 5), vscode.CodeActionKind.QuickFix.value);
    check(M("no rename offered when the server-only name already exists"), !(acts1 || []).some((a) => /^Rename/.test(a.title)), JSON.stringify((acts1 || []).map((a) => a.title)));
    if (rename) await vscode.workspace.applyEdit(rename.edit);
    check(M("rename edits only the name, never the value"), edoc.lineAt(2).text.startsWith("ASSIST=sk-") && edoc.lineAt(2).text.length === ("ASSIST=" + fx.KEYS.anthropic).length, edoc.lineAt(2).text.slice(0, 12));
    await edoc.save();
    await expectWait(M("BK001 and the dependent BK002 are gone after the rename"), () => !api.getFindings().some((f) => f.name === "NEXT_PUBLIC_ASSIST"), 20000);
    let T2 = TOTAL - 2;
    check(M("finding count after the rename"), api.getFindings().length === T2, String(api.getFindings().length));

    // Quick Fix from the panel's inline button (file not open).
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const topNow = await api.getTreeItems();
    const fixRowFile = topNow.find((t) => t.resourceUri && t.resourceUri.fsPath === P("fix/.env"));
    const frow = (await api.getTreeItems(fixRowFile.node))[0];
    check(M("fix/.env row is fixable"), frow.contextValue === "finding.fixable" && frow.label === "NEXT_PUBLIC_GROQ_API_KEY in .env is bundled into the browser", frow.label);
    const applied = await vscode.commands.executeCommand("browserKey.applyFix", frow.node);
    const fdoc = await vscode.workspace.openTextDocument(P("fix/.env"));
    check(M("panel applyFix renames the variable"), applied === true && fdoc.getText() === "GROQ_API_KEY=abc\n", fdoc.getText());
    await fdoc.save();
    await expectWait(M("fix/.env row gone and badge updated"), () => !api.getFindings().some((f) => f.rel === "fix/.env") && api.getBadge() === T2 - 1);
    check(M("applying the same (now stale) node again is refused"), (await vscode.commands.executeCommand("browserKey.applyFix", frow.node)) === false);
    T2 -= 1;
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // Live: unsaved edits are checked, revert clears them.
    const ldoc = await vscode.workspace.openTextDocument(P("live/live.tsx"));
    await vscode.window.showTextDocument(ldoc);
    const we = new vscode.WorkspaceEdit();
    we.insert(ldoc.uri, new vscode.Position(2, 0), "const c = new OpenAI({ dangerouslyAllowBrowser: true });\n");
    await vscode.workspace.applyEdit(we);
    await expectWait(M("unsaved edit is checked live"), () => api.getFindings().some((f) => f.rel === "live/live.tsx" && f.rule === "BK003"));
    await vscode.commands.executeCommand("workbench.action.files.revert");
    await expectWait(M("revert removes the live finding"), () => !api.getFindings().some((f) => f.rel === "live/live.tsx"));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // Disk changes to closed files: Rescan, and the focused-window poll (watchers may not fire here).
    fs.writeFileSync(P("gen/.env.production"), "VITE_OPENAI_KEY=1\nVITE_GROQ_KEY=2\n");
    await vscode.commands.executeCommand("browserKey.rescan");
    await expectWait(M("rescan picks up a disk change to a closed .env"), () => api.getFindings().filter((f) => f.rel === "gen/.env.production").length === 2);
    await sleep(1100);
    fs.writeFileSync(P("gen/.env.production"), "VITE_OPENAI_KEY=1\n");
    await api.poll();
    await expectWait(M("poll fallback picks up the change back"), () => api.getFindings().filter((f) => f.rel === "gen/.env.production").length === 1);
    await sleep(1100);
    fs.writeFileSync(P("apps/spa/src/keys.ts"), "export const ok = 1;\n");
    await api.poll();
    await expectWait(M("poll fallback re-checks a closed code file"), () => !api.getFindings().some((f) => f.rel === "apps/spa/src/keys.ts") && api.getFindings().length === T2 - 1);
    T2 -= 1;

    // Settings apply live.
    await conf().update("rules", { BK004: "off", BK002: "hint" }, vscode.ConfigurationTarget.Global);
    const n004 = api.getFindings().filter((f) => f.rule === "BK004").length;
    await expectWait(M("rules: BK004 off removes BK004"), () => !api.getFindings().some((f) => f.rule === "BK004") && api.getFindings().length === T2 - n004);
    const d2 = vscode.languages.getDiagnostics(page).filter((d) => d.code === "BK002");
    check(M("rules: BK002 severity hint applied"), d2.length === 1 && d2.every((d) => d.severity === vscode.DiagnosticSeverity.Hint), String(d2.length));
    await conf().update("rules", undefined, vscode.ConfigurationTarget.Global);
    await expectWait(M("rules reset restores the findings"), () => api.getFindings().length === T2);

    await conf().update("ignoreNames", "^NEXT_PUBLIC_OPENAI_API_KEY$", vscode.ConfigurationTarget.Global);
    await expectWait(M("ignoreNames hides a variable"), () => !api.getFindings().some((f) => f.name === "NEXT_PUBLIC_OPENAI_API_KEY") && api.getFindings().length === T2 - 2);
    await conf().update("ignoreNames", "(".repeat(5) + "a".repeat(250), vscode.ConfigurationTarget.Global);
    await expectWait(M("an over-long / invalid ignoreNames is ignored"), () => api.getFindings().length === T2);
    await conf().update("ignoreNames", undefined, vscode.ConfigurationTarget.Global);

    await conf().update("extraPublicPrefixes", ["STORYBOOK_"], vscode.ConfigurationTarget.Global);
    fs.writeFileSync(P("gen/.env.production"), "VITE_OPENAI_KEY=1\nSTORYBOOK_OPENAI_KEY=1\n");
    await vscode.commands.executeCommand("browserKey.rescan");
    await expectWait(M("extraPublicPrefixes adds a prefix"), () => api.getFindings().some((f) => f.name === "STORYBOOK_OPENAI_KEY"));
    await conf().update("extraPublicPrefixes", undefined, vscode.ConfigurationTarget.Global);
    await expectWait(M("extraPublicPrefixes reset"), () => !api.getFindings().some((f) => f.name === "STORYBOOK_OPENAI_KEY") && api.getFindings().length === T2);

    await conf().update("exclude", ["**/gen/**"], vscode.ConfigurationTarget.Global);
    await expectWait(M("exclude drops gen/.env.production"), () => !api.getFindings().some((f) => f.rel === "gen/.env.production") && api.getFindings().length === T2 - 1);
    check(M("mandatory excludes still apply with a custom exclude list"), !api.getFindings().some((f) => /node_modules|dist\//.test(f.rel)));
    await conf().update("exclude", ["**/**/**/**/**/**/*a*a*a*a*a*a*a*a*a*b", "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}"], vscode.ConfigurationTarget.Global);
    await expectWait(M("hostile exclude globs are refused, scan still completes"), () => api.getFindings().length === T2, 20000);
    await conf().update("exclude", undefined, vscode.ConfigurationTarget.Global);
    await expectWait(M("exclude reset"), () => api.getFindings().length === T2);

    if (trusted) {
      await conf().update("ignoreNames", "^VITE_", vscode.ConfigurationTarget.Workspace);
      await expectWait(M("trusted: workspace ignoreNames honoured"), () => !api.getFindings().some((f) => /^VITE_/.test(f.name || "")));
      await conf().update("ignoreNames", undefined, vscode.ConfigurationTarget.Workspace);
      await expectWait(M("workspace ignoreNames reset"), () => api.getFindings().length === T2);
    } else {
      check(M("untrusted: repository exclude / ignoreNames are not honoured"), api.getFindings().some((f) => f.rel.startsWith("apps/")) && api.getFindings().some((f) => f.rel.endsWith(".env.local")));
      check(M("untrusted: repository enabled / rules / maxFiles are not honoured"), new Set(api.getFindings().map((f) => f.rel)).size > 1 && api.getFindings().some((f) => f.rule === "BK001") && api.getFindings().some((f) => f.rule === "BK002"));
    }

    await conf().update("maxFiles", 1, vscode.ConfigurationTarget.Global);
    await expectWait(M("maxFiles caps the workspace scan"), () => new Set(api.getFindings().map((f) => f.rel)).size <= 1);
    await conf().update("maxFiles", undefined, vscode.ConfigurationTarget.Global);
    await expectWait(M("maxFiles reset"), () => api.getFindings().length === T2);

    await conf().update("enabled", false, vscode.ConfigurationTarget.Global);
    await expectWait(M("enabled=false empties view, badge, diagnostics"), async () => api.getBadge() === 0 && (await api.getTreeItems()).length === 0 && vscode.languages.getDiagnostics().every(([, ds]) => !ds.some((d) => d.source === "BrowserKey")));
    await conf().update("enabled", undefined, vscode.ConfigurationTarget.Global);
    await expectWait(M("re-enabled restores the badge"), () => api.getBadge() === T2);

    const cmds = await vscode.commands.getCommands(true);
    for (const c of ["browserKey.rescan", "browserKey.applyFix", "browserKey.openReference", "browserKey.openFinding", "browserKey.focusView", "browserKey.openSettings"]) check(M(`command ${c} registered`), cmds.includes(c));
    await vscode.commands.executeCommand("browserKey.rescan");
    check(M("rescan keeps the same findings"), api.getFindings().length === T2);
  } catch (e) {
    check(M("unexpected exception"), false, String(e && e.stack ? e.stack : e));
  }

  await vscode.commands.executeCommand("workbench.action.files.saveAll");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  fs.writeFileSync(resultFile, JSON.stringify({ passed, failed, results }, null, 2));
  if (failed) throw new Error(`${failed} in-editor checks failed`);
}

module.exports = { run };
