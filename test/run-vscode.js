"use strict";

// Launches a real, isolated VS Code window with BrowserKey loaded from this folder and runs
// test/vscode/index.js inside it, once trusted and once in an untrusted workspace. During the
// trusted run it takes a screenshot of the (hidden) display when the test asks for one.
// Usage: node test/run-vscode.js [tmpBaseDir]

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const fx = require("./fixtures");

const extDir = path.resolve(__dirname, "..");
const base = fs.mkdtempSync(path.join(process.argv[2] || os.tmpdir(), "bk-vscode-"));
const outsideDir = path.join(base, "outside");
fs.mkdirSync(outsideDir);
fs.writeFileSync(path.join(outsideDir, "evil.tsx"), '"use client";\nconst k = process.env.NEXT_PUBLIC_OPENAI_API_KEY;\n');
fs.writeFileSync(path.join(outsideDir, ".env"), "NEXT_PUBLIC_OPENAI_API_KEY=1\n");

const TITLE = "browserkey-shot-" + process.pid;

function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

/** A fresh fixture workspace (each run edits files, so each run gets its own copy). */
function makeWorkspace(name) {
  const root = path.join(base, name);
  for (const [rel, text] of Object.entries(fx.workspace())) write(root, rel, text);
  for (const [rel, text] of Object.entries(fx.extraFiles())) write(root, rel, text);
  write(root, "big.tsx", '"use client";\nconst k = process.env.NEXT_PUBLIC_OPENAI_API_KEY;\n' + "// padding\n".repeat(120000));
  fs.symlinkSync(path.join(outsideDir, "evil.tsx"), path.join(root, "link.tsx"));
  fs.symlinkSync(path.join(outsideDir, ".env"), path.join(root, "linked.env"));
  if (name.endsWith("untrusted")) {
    // A hostile repository trying to hide its own findings: must be ignored while untrusted.
    write(root, ".vscode/settings.json", JSON.stringify({ "browserKey.exclude": ["**/apps/**", "**/*.env*"], "browserKey.ignoreNames": ".*", "browserKey.enabled": false, "browserKey.rules": { BK001: "off", BK002: "off" }, "browserKey.maxFiles": 1 }));
  }
  return root;
}

const userDir = path.join(base, "user");
const extsDir = path.join(base, "exts");
fs.mkdirSync(path.join(userDir, "User"), { recursive: true });
fs.mkdirSync(extsDir, { recursive: true });
const settingsPath = path.join(userDir, "User", "settings.json");
fs.writeFileSync(
  settingsPath,
  JSON.stringify({
    "security.workspace.trust.enabled": false,
    "extensions.autoUpdate": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "workbench.startupEditor": "none",
    "files.hotExit": "off",
    "window.restoreWindows": "none",
    "window.newWindowDimensions": "maximized",
    "window.title": TITLE + " ${rootName}",
    "workbench.sideBar.location": "left",
  }, null, 2)
);

const resultFile = path.join(base, "results.json");
const cfgFile = path.join(base, "config.json");
const markerDir = path.join(base, "markers");
fs.mkdirSync(markerDir);
const shot = path.join(base, "browserkey-panel.png");

function raiseOwnWindow() {
  try {
    execFileSync("xdotool", ["mousemove", "1595", "995"]);
  } catch (_) {
    /* no xdotool */
  }
  try {
    const ids = execFileSync("xdotool", ["search", "--name", TITLE]).toString().trim().split(/\s+/).filter(Boolean);
    for (const id of ids) {
      try {
        execFileSync("xdotool", ["windowraise", id]);
      } catch (_) {
        /* window gone */
      }
    }
  } catch (_) {
    /* xdotool missing or no match: capture as is */
  }
}

/** Raise the test window and capture the display; retry when the capture is blank. */
function screenshot() {
  const display = process.env.DISPLAY || ":99";
  for (let attempt = 1; attempt <= 5; attempt++) {
    raiseOwnWindow();
    execFileSync("sleep", ["1"]);
    try {
      execFileSync("import", ["-window", "root", "-display", display, shot]);
      const sd = Number(execFileSync("convert", [shot, "-colorspace", "Gray", "-format", "%[fx:standard_deviation]", "info:"]).toString());
      console.log(`screenshot: ${shot} (attempt ${attempt}, contrast ${sd.toFixed(3)})`);
      if (sd > 0.05) return;
    } catch (e) {
      console.log("screenshot failed: " + e.message);
    }
  }
}

async function launch(mode, extraArgs) {
  const root = makeWorkspace("ws-" + mode);
  fs.writeFileSync(cfgFile, JSON.stringify({ mode, root, outsideDir, resultFile, markerDir }));
  const args = [
    "--wait", "--new-window",
    "--user-data-dir", userDir,
    "--extensions-dir", extsDir,
    "--disable-extensions",
    ...extraArgs,
    "--skip-welcome", "--skip-release-notes",
    "--extensionDevelopmentPath=" + extDir,
    "--extensionTestsPath=" + path.join(__dirname, "vscode", "index.js"),
    root,
  ];
  console.log("code " + args.join(" "));
  const child = spawn("code", args, { stdio: "inherit", env: Object.assign({}, process.env, { BK_TEST_CONFIG: cfgFile }) });
  const done = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const killer = setTimeout(() => child.kill("SIGKILL"), 300000);
  const poll = setInterval(() => {
    const want = path.join(markerDir, "shot-" + mode);
    if (fs.existsSync(want)) {
      fs.unlinkSync(want);
      screenshot();
      fs.writeFileSync(path.join(markerDir, "shot-done-" + mode), "1");
    }
  }, 300);
  const code = await done;
  clearTimeout(killer);
  clearInterval(poll);
  console.log("code exit status:", code);
  if (!fs.existsSync(resultFile)) {
    console.log("FAIL: no results written");
    return { passed: 0, failed: 1, results: [] };
  }
  const res = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  fs.unlinkSync(resultFile);
  for (const t of res.results) console.log((t.ok ? "PASS " : "FAIL ") + t.name + (t.detail ? " :: " + t.detail : ""));
  return res;
}

(async () => {
  const r1 = await launch("trusted", ["--disable-workspace-trust"]);

  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  s["security.workspace.trust.enabled"] = true;
  s["security.workspace.trust.startupPrompt"] = "never";
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
  const r2 = await launch("untrusted", []);

  const passed = r1.passed + r2.passed;
  const failed = r1.failed + r2.failed;
  console.log(`\nin-editor tests: ${passed} passed, ${failed} failed (trusted run ${r1.passed}/${r1.passed + r1.failed}, untrusted run ${r2.passed}/${r2.passed + r2.failed})`);
  process.exit(failed ? 1 : 0);
})();
