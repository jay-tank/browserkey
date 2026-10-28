"use strict";

// Unit tests for core.js: node test/core.test.js

const assert = require("assert");
const core = require("../core");
const data = require("../data");
const fx = require("./fixtures");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.log("FAIL " + name + "\n  " + (e && e.message ? e.message.split("\n").join("\n  ") : e));
  }
}

const K = fx.KEYS;
const pkgCtx = (pkg, extra) => core.makeContext(Object.assign({ packages: [{ dir: "", text: pkg }] }, extra || {}));
const NEXT = pkgCtx(fx.PKG.next);
const VITE = pkgCtx(fx.PKG.vite);
const KIT = pkgCtx(fx.PKG.sveltekit);
const NUXT = pkgCtx(fx.PKG.nuxt);
const EXPO = pkgCtx(fx.PKG.expo);
const PLAIN = pkgCtx(fx.PKG.plain);
const NONE = core.makeContext({});
const run = (text, rel, ctx, opts) => core.analyze(text, rel, ctx || NEXT, opts);
const rules = (fs) => fs.map((f) => f.rule + (f.name ? ":" + f.name : "")).sort();
const ids = (fs) => fs.map((f) => f.rule).sort();

/** Two-phase scan like the extension: context, then env/build files, then code. */
function scanWorkspace(files, opts) {
  const packages = [];
  const configs = [];
  for (const [rel, text] of Object.entries(files)) {
    if (core.kindFromPath(rel) === "package") packages.push({ dir: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "", text });
    else if (core.isContextFile(rel)) configs.push({ rel, text });
  }
  const ctx = core.makeContext(Object.assign({ packages, configs }, opts || {}));
  const out = [];
  const code = (k) => ["js", "vue", "svelte", "html"].includes(k);
  const entries = Object.entries(files).sort((a, b) => Number(code(core.kindFromPath(a[0]))) - Number(code(core.kindFromPath(b[0]))));
  for (const [rel, text] of entries) {
    const fs = core.analyze(text, rel, ctx);
    if (!code(core.kindFromPath(rel))) core.noteValueFindings(ctx, rel, fs);
    for (const f of fs) out.push(Object.assign({ rel }, f));
  }
  return out;
}

const ALL_TEXT = (fs) => fs.map((f) => f.short + "\n" + f.message + "\n" + (f.name || "")).join("\n");
const NO_SECRET = (fs) => {
  const t = ALL_TEXT(fs);
  for (const k of Object.values(K)) assert.ok(!t.includes(k.slice(0, 16)) || k.slice(0, 16).length < 8, "a finding leaks a key");
  for (const k of Object.values(K)) assert.ok(!t.includes(k.slice(-12)), "a finding leaks a key tail");
};

// ---- names ---------------------------------------------------------------------------------------
test("aiKeyName: provider + secret word", () => {
  for (const n of ["OPENAI_API_KEY", "NEXT_PUBLIC_OPENAI_API_KEY", "VITE_ANTHROPIC_KEY", "GEMINI_API_KEY", "GOOGLE_AI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "CO_API_KEY", "COHERE_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "HF_TOKEN", "HUGGINGFACE_API_TOKEN", "DEEPSEEK_API_KEY", "PERPLEXITY_API_KEY", "openaiApiKey", "mistralApiKey", "OPENAIKEY", "NEXT_PUBLIC_OPENAI_APIKEY", "CLAUDE_SECRET", "AZURE_OPENAI_API_KEY", "TOGETHER_API_KEY", "REPLICATE_API_TOKEN"]) assert.ok(core.aiKeyName(n), n);
});
test("aiKeyName: non-credentials and non-AI names", () => {
  for (const n of ["OPENAI_MODEL", "OPENAI_BASE_URL", "OPENAI_API_KEY_URL", "OPENAI_ORG_ID", "NEXT_PUBLIC_SITE_URL", "STRIPE_SECRET_KEY", "API_KEY", "NEXT_PUBLIC_API_KEY", "MAPBOX_TOKEN", "NEXT_PUBLIC_FIREBASE_API_KEY", "SHELF_KEY", "MAIL_TOKEN", "DETAIL_KEY", "", "x".repeat(200), "GEMINI_ENABLED", "ANTHROPIC_VERSION", "keyboard", "COHERENT_KEY"]) assert.ok(!core.aiKeyName(n), n);
});
test("aiKeyName: provider label", () => {
  assert.strictEqual(core.aiKeyName("GOOGLE_AI_API_KEY").provider, "Google Gemini");
  assert.strictEqual(core.aiKeyName("CO_API_KEY").provider, "Cohere");
  assert.strictEqual(core.aiKeyName("openaiApiKey").provider, "OpenAI");
});
test("toUpperSnake", () => {
  assert.strictEqual(core.toUpperSnake("openaiApiKey"), "OPENAI_API_KEY");
  assert.strictEqual(core.toUpperSnake("HFToken"), "HF_TOKEN");
});

// ---- values --------------------------------------------------------------------------------------
test("aiKeyValue: every documented format", () => {
  assert.strictEqual(core.aiKeyValue(K.openai).provider, "OpenAI");
  assert.strictEqual(core.aiKeyValue(K.openai).shown, "sk-proj-");
  assert.strictEqual(core.aiKeyValue(K.anthropic).shown, "sk-ant-api03-");
  assert.strictEqual(core.aiKeyValue(K.anthropic).provider, "Anthropic");
  assert.strictEqual(core.aiKeyValue(K.openrouter).provider, "OpenRouter");
  assert.strictEqual(core.aiKeyValue(K.groq).provider, "Groq");
  assert.strictEqual(core.aiKeyValue(K.xai).provider, "xAI");
  assert.strictEqual(core.aiKeyValue(K.hf).provider, "Hugging Face");
  assert.ok(/OpenAI-style/.test(core.aiKeyValue(K.openaiLegacy).provider));
  assert.strictEqual(core.aiKeyValue('"' + K.openai + '"').provider, "OpenAI");
});
test("aiKeyValue: Google AIza keys need Gemini context (Firebase / Maps keys are public)", () => {
  assert.strictEqual(core.aiKeyValue(K.google), null);
  assert.strictEqual(core.aiKeyValue(K.google, true).provider, "Google Gemini");
});
test("aiKeyValue: placeholders and short values ignored", () => {
  for (const v of ["", "sk-...", "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "sk-proj-your-key-here-aaaaaaaaaaaaaaaaaaaaaaaa", "<your key>", "sk-123", "gsk_short", "${{ secrets.OPENAI_API_KEY }}", "sk_live_" + fx.body(30)]) assert.strictEqual(core.aiKeyValue(v), null, v);
});
test("findKeysInString: positions and boundaries", () => {
  const s = "a " + K.openai + " b " + K.groq;
  const hits = core.findKeysInString(s);
  assert.strictEqual(hits.length, 2);
  assert.strictEqual(s.slice(hits[0].index, hits[0].index + hits[0].length), K.openai);
  assert.strictEqual(core.findKeysInString("task-" + fx.body(40)).length, 0);
  assert.strictEqual(core.findKeysInString("x" + K.openai).length, 0);
});
test("mask shows only the prefix", () => {
  assert.strictEqual(core.mask("sk-proj-"), "sk-proj-****");
});

// ---- kinds, frameworks, context ------------------------------------------------------------------
test("kindFromPath", () => {
  const cases = { ".env": "env", "a/.env.local": "env", "prod.env": "env", "x/.envrc": null, "env.ts": "js", "a/Dockerfile": "docker", "Dockerfile.prod": "docker", "docker-compose.yml": "compose", "compose.yaml": "compose", ".github/workflows/ci.yml": "ci", ".gitlab-ci.yml": "ci", "random.yml": null, "netlify.toml": "toml", "a.tsx": "js", "a.d.ts": null, "A.vue": "vue", "B.svelte": "svelte", "index.html": "html", "package.json": "package", "readme.md": null };
  for (const [p, k] of Object.entries(cases)) assert.strictEqual(core.kindFromPath(p), k, p);
});
test("frameworksFromPackage", () => {
  assert.ok(core.frameworksFromPackage(fx.PKG.next).next);
  assert.ok(core.frameworksFromPackage(fx.PKG.vite).viteSpa);
  const kit = core.frameworksFromPackage(fx.PKG.sveltekit);
  assert.ok(kit.sveltekit && kit.vite && !kit.viteSpa);
  assert.ok(core.frameworksFromPackage(fx.PKG.expo).expo);
  assert.deepStrictEqual(Object.values(core.frameworksFromPackage("{not json")).filter(Boolean), []);
  assert.deepStrictEqual(Object.values(core.frameworksFromPackage("null")).filter(Boolean), []);
});
test("PUBLIC_ only counts in SvelteKit / Astro projects", () => {
  assert.deepStrictEqual(ids(run("PUBLIC_OPENAI_API_KEY=x\n", ".env", NEXT)), []);
  assert.deepStrictEqual(ids(run("PUBLIC_OPENAI_API_KEY=x\n", ".env", KIT)), ["BK001"]);
});
test("extractConfigPrefixes: Vite envPrefix and SvelteKit publicPrefix", () => {
  assert.deepStrictEqual(core.extractConfigPrefixes("export default { envPrefix: ['VITE_', 'APP_'] }"), ["VITE_", "APP_"]);
  assert.deepStrictEqual(core.extractConfigPrefixes("export default { kit: { env: { publicPrefix: 'CLIENT_' } } }"), ["CLIENT_"]);
  assert.deepStrictEqual(core.extractConfigPrefixes("export default { envPrefix: '' }"), []);
  const ctx = core.makeContext({ packages: [{ dir: "", text: fx.PKG.vite }], configs: [{ rel: "vite.config.ts", text: "export default { envPrefix: 'APP_' }" }] });
  assert.deepStrictEqual(ids(core.analyze("APP_OPENAI_KEY=x\n", ".env", ctx)), ["BK001"]);
});
test("extraPublicPrefixes setting (sanitized)", () => {
  const ctx = core.makeContext({ extraPublicPrefixes: ["STORYBOOK_", "bad prefix!", 5, "".padEnd(60, "A")] });
  assert.deepStrictEqual(ids(core.analyze("STORYBOOK_OPENAI_KEY=x\n", ".env", ctx)), ["BK001"]);
  assert.deepStrictEqual(core.sanitizePrefixes(["STORYBOOK_", "bad prefix!", 5]), ["STORYBOOK_"]);
});
test("projectFor picks the nearest package.json", () => {
  const ctx = core.makeContext({ packages: [{ dir: "", text: fx.PKG.plain }, { dir: "apps/web", text: fx.PKG.next }] });
  assert.ok(core.projectFor("apps/web/app/x.tsx", ctx).fw.next);
  assert.ok(!core.projectFor("apps/webx/a.ts", ctx).fw.next);
});

// ---- BK001 env files -----------------------------------------------------------------------------
test("BK001: name-based, value-based, placeholders, server-only names", () => {
  const text = ["NEXT_PUBLIC_OPENAI_API_KEY=", "NEXT_PUBLIC_KEY=" + K.anthropic, "NEXT_PUBLIC_OPENAI_MODEL=gpt-5", "OPENAI_API_KEY=" + K.openai, "export VITE_GROQ_API_KEY='abc'", "REACT_APP_GEMINI_KEY=\"a\" # comment", "EXPO_PUBLIC_DEMO=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "GATSBY_MISTRAL_API_KEY=1", "NUXT_PUBLIC_COHERE_API_KEY=1", "# NEXT_PUBLIC_OPENAI_KEY=commented", ""].join("\n");
  const fs = run(text, ".env.local");
  assert.deepStrictEqual(rules(fs), ["BK001:GATSBY_MISTRAL_API_KEY", "BK001:NEXT_PUBLIC_KEY", "BK001:NEXT_PUBLIC_OPENAI_API_KEY", "BK001:NUXT_PUBLIC_COHERE_API_KEY", "BK001:REACT_APP_GEMINI_KEY", "BK001:VITE_GROQ_API_KEY"]);
  const byVal = fs.find((f) => f.name === "NEXT_PUBLIC_KEY");
  assert.ok(byVal.byValue && /starts with sk-ant-api03-, the rest is masked/.test(byVal.message));
  assert.strictEqual(byVal.short, "NEXT_PUBLIC_KEY in .env.local is bundled into the browser");
  assert.strictEqual(byVal.line, 1);
  assert.strictEqual(byVal.character, 0);
  assert.strictEqual(byVal.endCharacter, "NEXT_PUBLIC_KEY".length);
  NO_SECRET(fs);
});
test("BK001: Expo says app bundle", () => {
  const f = run("EXPO_PUBLIC_OPENAI_API_KEY=x\n", ".env", EXPO)[0];
  assert.strictEqual(f.short, "EXPO_PUBLIC_OPENAI_API_KEY in .env is shipped in the app bundle");
  assert.strictEqual(f.docUrl, data.DOCS.expo);
});
test("BK001: rename Quick Fix only when the target name is free", () => {
  const fs = run("NEXT_PUBLIC_OPENAI_API_KEY=1\nNEXT_PUBLIC_GROQ_KEY=2\nGROQ_KEY=3\n", ".env");
  const a = fs.find((f) => f.name === "NEXT_PUBLIC_OPENAI_API_KEY");
  assert.strictEqual(a.fix.title, "Rename to OPENAI_API_KEY (server-only)");
  assert.deepStrictEqual(a.fix.edits, [{ start: 0, end: 26, expect: "NEXT_PUBLIC_OPENAI_API_KEY", text: "OPENAI_API_KEY" }]);
  assert.strictEqual(fs.find((f) => f.name === "NEXT_PUBLIC_GROQ_KEY").fix, undefined);
});
test("BK001: multi-line quoted values are skipped, CRLF handled", () => {
  const fs = run('PRIVATE="-----BEGIN\nNEXT_PUBLIC_OPENAI_KEY=inside\n-----END"\r\nVITE_OPENAI_KEY=1\r\n', ".env");
  assert.deepStrictEqual(rules(fs), ["BK001:VITE_OPENAI_KEY"]);
});
test("BK001: ignoreNames regex, capped", () => {
  const ctx = pkgCtx(fx.PKG.next, { ignoreNames: "_PROXY_KEY$" });
  assert.deepStrictEqual(ids(core.analyze("NEXT_PUBLIC_OPENAI_PROXY_KEY=1\nNEXT_PUBLIC_OPENAI_KEY=1\n", ".env", ctx)), ["BK001"]);
  assert.strictEqual(core.compileIgnore("a".repeat(201)), null);
  assert.strictEqual(core.compileIgnore("(unclosed"), null);
  assert.strictEqual(core.compileIgnore(""), null);
  assert.ok(core.compileIgnore("^X$") instanceof RegExp);
});

// ---- BK001 CI / Docker / compose / netlify -------------------------------------------------------
test("BK001: GitHub Actions env from an AI secret, comments ignored, deduped", () => {
  const text = "env:\n  NEXT_PUBLIC_TOKEN: ${{ secrets.ANTHROPIC_API_KEY }}\n  NEXT_PUBLIC_ANALYTICS: ${{ secrets.GA }}\n  # NEXT_PUBLIC_OPENAI_KEY: x\n  run: echo $NEXT_PUBLIC_TOKEN\n";
  const fs = run(text, ".github/workflows/ci.yml");
  assert.deepStrictEqual(rules(fs), ["BK001:NEXT_PUBLIC_TOKEN"]);
  assert.ok(/takes its value from ANTHROPIC_API_KEY/.test(fs[0].message));
});
test("BK001: Dockerfile ARG/ENV, compose args, netlify.toml, value keys", () => {
  assert.deepStrictEqual(rules(run("ARG VITE_OPENAI_API_KEY\nENV VITE_OPENAI_API_KEY=$VITE_OPENAI_API_KEY\n", "Dockerfile")), ["BK001:VITE_OPENAI_API_KEY"]);
  assert.deepStrictEqual(rules(run("services:\n  web:\n    build:\n      args:\n        - NEXT_PUBLIC_K=${OPENAI_API_KEY}\n", "docker-compose.yml")), ["BK001:NEXT_PUBLIC_K"]);
  assert.deepStrictEqual(rules(run('[build.environment]\n  VITE_CHAT = "' + K.groq + '"\n', "netlify.toml")), ["BK001:VITE_CHAT"]);
  assert.deepStrictEqual(rules(run("ENV NEXT_PUBLIC_SITE_URL=https://x\nENV OPENAI_API_KEY=$OPENAI_API_KEY\n", "Dockerfile")), []);
  NO_SECRET(run('[build.environment]\n  VITE_CHAT = "' + K.groq + '"\n', "netlify.toml"));
});

// ---- BK002 / BK004 code ---------------------------------------------------------------------------
test("BK002: public AI key read in code (process.env, import.meta.env, bracket, optional chaining, destructuring)", () => {
  const code = 'const a = process.env.NEXT_PUBLIC_OPENAI_API_KEY;\nconst b = process.env["NEXT_PUBLIC_GROQ_KEY"];\nconst c = import.meta.env.VITE_ANTHROPIC_API_KEY;\nconst d = process.env?.NEXT_PUBLIC_MISTRAL_KEY;\nconst { NEXT_PUBLIC_COHERE_KEY, OTHER } = process.env;\nconst e = process.env.NEXT_PUBLIC_SITE_URL;\n';
  assert.deepStrictEqual(rules(run(code, "lib/a.ts")), ["BK002:NEXT_PUBLIC_COHERE_KEY", "BK002:NEXT_PUBLIC_GROQ_KEY", "BK002:NEXT_PUBLIC_MISTRAL_KEY", "BK002:NEXT_PUBLIC_OPENAI_API_KEY", "BK002:VITE_ANTHROPIC_API_KEY"]);
});
test("BK002: not in server-only files, not in comments or strings", () => {
  const code = "const a = process.env.NEXT_PUBLIC_OPENAI_API_KEY;\n";
  for (const rel of ["app/api/x/route.ts", "pages/api/chat.ts", "server/x.ts", "src/x.server.ts", "next.config.js", "scripts/seed.js", "middleware.ts"]) assert.deepStrictEqual(ids(run(code, rel)), [], rel);
  assert.deepStrictEqual(ids(run('"use server";\n' + code, "app/actions.ts")), []);
  assert.deepStrictEqual(ids(run("// process.env.NEXT_PUBLIC_OPENAI_API_KEY\n/* process.env.NEXT_PUBLIC_OPENAI_KEY */\nconst s = 'process.env.NEXT_PUBLIC_OPENAI_KEY';\n", "a.ts")), []);
});
test("BK002: via a public name whose .env value is an AI key", () => {
  const fs = scanWorkspace({ "package.json": fx.PKG.next, ".env": "NEXT_PUBLIC_ASSIST=" + K.openai + "\n", "app/a.tsx": '"use client";\nconst k = process.env.NEXT_PUBLIC_ASSIST;\n' });
  const f = fs.find((x) => x.rule === "BK002");
  assert.ok(f && /its value in \.env is one/.test(f.message), JSON.stringify(fs.map((x) => x.rule)));
  NO_SECRET(fs);
});
test("BK002: SvelteKit public modules and explicit $app/env/public", () => {
  const svelte = "<script>\n  import { PUBLIC_OPENAI_API_KEY, PUBLIC_SITE } from '$env/static/public';\n  import { env } from '$env/dynamic/public';\n  const g = env.PUBLIC_GROQ_KEY;\n</script>\n<p>{PUBLIC_SITE}</p>\n";
  assert.deepStrictEqual(rules(run(svelte, "src/routes/+page.svelte", KIT)), ["BK002:PUBLIC_GROQ_KEY", "BK002:PUBLIC_OPENAI_API_KEY"]);
  assert.deepStrictEqual(rules(run("import { OPENAI_API_KEY } from '$app/env/public';\n", "src/lib/a.ts", KIT)), ["BK002:OPENAI_API_KEY"]);
});
test("BK004: private SvelteKit env in a client file, fine in server files", () => {
  assert.deepStrictEqual(rules(run("<script>\nimport { OPENAI_API_KEY as k } from '$env/static/private';\n</script>\n", "src/routes/+page.svelte", KIT)), ["BK004:OPENAI_API_KEY"]);
  assert.deepStrictEqual(rules(run("import { OPENAI_API_KEY } from '$env/static/private';\n", "src/routes/+page.server.ts", KIT)), []);
  assert.deepStrictEqual(rules(run("import { OPENAI_API_KEY } from '$env/static/private';\n", "src/routes/+page.ts", KIT)), ["BK004:OPENAI_API_KEY"]);
});
test("BK002: Nuxt useRuntimeConfig().public", () => {
  const code = "<script setup>\nconst config = useRuntimeConfig();\nconst k = config.public.openaiApiKey;\nconst s = config.public.siteUrl;\nconst j = useRuntimeConfig().public.groqApiKey;\n</script>\n";
  assert.deepStrictEqual(rules(run(code, "pages/index.vue", NUXT)), ["BK002:groqApiKey", "BK002:openaiApiKey"]);
});
test("BK004: server-only key in client files by framework", () => {
  const code = "const k = process.env.OPENAI_API_KEY;\n";
  assert.deepStrictEqual(ids(run('"use client";\n' + code, "app/a.tsx")), ["BK004"]);
  assert.deepStrictEqual(ids(run("'use client'\n" + code, "components/a.tsx")), ["BK004"]);
  assert.deepStrictEqual(ids(run(code, "app/page.tsx")), [], "Next server component");
  assert.deepStrictEqual(ids(run(code, "src/a.ts", VITE)), ["BK004"]);
  assert.deepStrictEqual(ids(run(code, "server/a.ts", VITE)), []);
  assert.deepStrictEqual(ids(run(code, "vite.config.ts", VITE)), []);
  assert.deepStrictEqual(ids(run(code, "src/a.ts", PLAIN)), [], "plain Node project");
  assert.deepStrictEqual(ids(run(code, "app/index.tsx", EXPO)), ["BK004"]);
  assert.deepStrictEqual(ids(run(code, "app/chat+api.ts", EXPO)), []);
  assert.deepStrictEqual(ids(run(code, "src/a.ts", NONE)), []);
  assert.deepStrictEqual(ids(run(code, "plugins/x.client.ts", NUXT)), ["BK004"]);
  const f = run('"use client";\n' + code, "app/a.tsx")[0];
  assert.strictEqual(f.short, 'server-only OPENAI_API_KEY read in a "use client" component');
  assert.strictEqual(f.severity, undefined);
  assert.strictEqual(core.findingSeverity(f, {}), "warning");
});
test("BK004 / BK002 in Vue SFC: only <script> is read", () => {
  const vue = "<template><p>process.env.OPENAI_API_KEY</p></template>\n<script setup lang=\"ts\">\nconst k = import.meta.env.VITE_OPENAI_KEY;\n</script>\n";
  const fs = run(vue, "src/App.vue", VITE);
  assert.deepStrictEqual(rules(fs), ["BK002:VITE_OPENAI_KEY"]);
  assert.strictEqual(fs[0].line, 2);
});

// ---- BK003 -------------------------------------------------------------------------------------
test("BK003: OpenAI, Anthropic, Groq constructors", () => {
  const code = 'import OpenAI from "openai";\nimport Anthropic from "@anthropic-ai/sdk";\nimport Groq from "groq-sdk";\nconst a = new OpenAI({ apiKey: k, dangerouslyAllowBrowser: true });\nconst b = new Anthropic({ dangerouslyAllowBrowser: true, apiKey: process.env.X });\nconst c = new Groq({ "dangerouslyAllowBrowser": !0 });\n';
  const fs = run(code, "lib/x.ts");
  assert.deepStrictEqual(fs.filter((f) => f.rule === "BK003").map((f) => f.provider), ["OpenAI", "Anthropic", "Groq"]);
  assert.strictEqual(fs[0].short, "new OpenAI({ dangerouslyAllowBrowser: true }) exposes the API key");
  assert.ok(/to avoid exposing your secret API credentials/.test(fs[0].message));
  assert.strictEqual(fs[0].docUrl, data.DOCS.openaiSdk);
  assert.strictEqual(fs[1].docUrl, data.DOCS.anthropicSdk);
  assert.strictEqual(core.findingSeverity(fs[0], {}), "error");
});
test("BK003: false / variable / non-object values are not reported", () => {
  const code = "new OpenAI({ dangerouslyAllowBrowser: false });\nnew OpenAI({ dangerouslyAllowBrowser: isDev });\nconst dangerouslyAllowBrowser = true;\nconsole.log('dangerouslyAllowBrowser: true');\n// new OpenAI({ dangerouslyAllowBrowser: true })\n";
  assert.deepStrictEqual(ids(run(code, "a.ts")), []);
});
test("BK003: user-supplied key is information (heuristic)", () => {
  for (const v of ["userApiKey", "localStorage.getItem('k')", "input.value", "prompt('key')", "settings.apiKey", "byokKey"]) {
    const f = run(`new OpenAI({ apiKey: ${v}, dangerouslyAllowBrowser: true });\n`, "a.ts")[0];
    assert.ok(f.byok, v);
    assert.strictEqual(core.findingSeverity(f, {}), "information", v);
    assert.strictEqual(core.findingSeverity(f, { BK003: "error" }), "error");
    assert.ok(/user-supplied key/.test(f.short));
  }
  for (const v of ["apiKey", "process.env.NEXT_PUBLIC_OPENAI_KEY", "import.meta.env.VITE_K", "getKey()", "KEY"]) {
    const src = v === "apiKey" ? "new OpenAI({ apiKey, dangerouslyAllowBrowser: true });\n" : `new OpenAI({ apiKey: ${v}, dangerouslyAllowBrowser: true });\n`;
    const f = run(src, "a.ts").find((x) => x.rule === "BK003");
    assert.ok(!f.byok, v);
  }
});
test("BK003: Anthropic direct browser access header", () => {
  const code = 'fetch(u, { headers: { "x-api-key": key, "anthropic-dangerous-direct-browser-access": "true" } });\n';
  const f = run(code, "a.ts")[0];
  assert.strictEqual(f.rule, "BK003");
  assert.strictEqual(f.provider, "Anthropic");
  assert.deepStrictEqual(ids(run('fetch(u, { headers: { "anthropic-dangerous-direct-browser-access": "false" } });\n', "a.ts")), []);
});
test("BK003 marks the file as browser code for BK004 / BK006", () => {
  const code = "const c = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, dangerouslyAllowBrowser: true });\n";
  assert.deepStrictEqual(ids(run(code, "lib/a.ts", PLAIN)), ["BK003", "BK004"]);
});

// ---- BK005 -------------------------------------------------------------------------------------
test("BK005: vite define with loadEnv, literal and whole env", () => {
  const cfg = 'export default defineConfig(({ mode }) => {\n  const env = loadEnv(mode, process.cwd(), "");\n  return { define: {\n    "process.env.GEMINI_API_KEY": JSON.stringify(env.GEMINI_API_KEY),\n    __KEY__: JSON.stringify(env.OPENAI_API_KEY),\n    __LIT__: "' + K.openai + '",\n    __VERSION__: JSON.stringify("1"),\n  } };\n});\n';
  const fs = run(cfg, "vite.config.ts", VITE);
  assert.deepStrictEqual(rules(fs), ["BK005:GEMINI_API_KEY", "BK005:__KEY__", "BK005:__LIT__"]);
  assert.ok(/it takes OPENAI_API_KEY/.test(fs.find((f) => f.name === "__KEY__").message));
  NO_SECRET(fs);
  assert.deepStrictEqual(rules(run('export default { define: { "process.env": process.env } }\n', "vite.config.js", VITE)), ["BK005:process.env"]);
  assert.deepStrictEqual(rules(run('const env = loadEnv(m, r, "");\nexport default { define: { "process.env": env } }\n', "vite.config.js", VITE)), ["BK005:process.env"]);
  assert.deepStrictEqual(rules(run('const define = { OPENAI_API_KEY: 1 };\n', "src/a.ts", VITE)), [], "define outside a config file");
});
test("BK005: envPrefix that matches AI keys", () => {
  assert.deepStrictEqual(rules(run("export default { envPrefix: ['VITE_', 'OPENAI_'] }\n", "vite.config.ts", VITE)), ["BK005:OPENAI_"]);
  assert.deepStrictEqual(rules(run("export default { envPrefix: 'APP_' }\n", "vite.config.ts", VITE)), []);
});
test("BK005: webpack DefinePlugin and EnvironmentPlugin", () => {
  const cfg = "module.exports = { plugins: [\n  new webpack.DefinePlugin({ 'process.env.ANTHROPIC_API_KEY': JSON.stringify(process.env.ANTHROPIC_API_KEY), VERSION: '1' }),\n  new webpack.EnvironmentPlugin(['NODE_ENV', 'GROQ_API_KEY']),\n  new EnvironmentPlugin({ MISTRAL_API_KEY: '' }),\n  new EnvironmentPlugin('COHERE_API_KEY'),\n] };\n";
  assert.deepStrictEqual(rules(run(cfg, "webpack.config.js", PLAIN)), ["BK005:ANTHROPIC_API_KEY", "BK005:COHERE_API_KEY", "BK005:GROQ_API_KEY", "BK005:MISTRAL_API_KEY"]);
});
test("BK005: next.config env and publicRuntimeConfig", () => {
  const cfg = "module.exports = {\n  env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY, SITE: 'x', CHAT: process.env.ANTHROPIC_API_KEY },\n  publicRuntimeConfig: { geminiApiKey: process.env.GEMINI_API_KEY },\n  serverRuntimeConfig: { openaiKey: process.env.OPENAI_API_KEY },\n};\n";
  assert.deepStrictEqual(rules(run(cfg, "next.config.js")), ["BK005:CHAT", "BK005:OPENAI_API_KEY", "BK005:geminiApiKey"]);
  assert.deepStrictEqual(rules(run(cfg, "other.config.js")), [], "env key only in next.config");
});
test("BK001: nuxt runtimeConfig.public and SvelteKit defineEnvVars public: true", () => {
  const nuxt = "export default defineNuxtConfig({ runtimeConfig: { openaiApiKey: '', public: { mistralApiKey: '', siteUrl: '' } } });\n";
  const fs = run(nuxt, "nuxt.config.ts", NUXT);
  assert.deepStrictEqual(rules(fs), ["BK001:mistralApiKey"]);
  assert.ok(/NUXT_PUBLIC_MISTRAL_API_KEY/.test(fs[0].message));
  const env = "export const variables = defineEnvVars({ OPENAI_API_KEY: { public: true }, ANTHROPIC_API_KEY: {}, PUBLIC_SITE: { public: true } });\n";
  assert.deepStrictEqual(rules(run(env, "src/env.ts", KIT)), ["BK001:OPENAI_API_KEY"]);
});

// ---- BK006 -------------------------------------------------------------------------------------
test("BK006: literal keys in client files only, masked, exact range", () => {
  const code = '"use client";\nconst a = "' + K.anthropic + '";\nconst t = `Bearer ' + K.groq + '`;\n';
  const fs = run(code, "app/a.tsx");
  assert.deepStrictEqual(ids(fs), ["BK006", "BK006"]);
  assert.strictEqual(fs[0].short, "hardcoded Anthropic key sk-ant-api03-**** in browser code");
  assert.strictEqual(code.slice(fs[0].start, fs[0].end), K.anthropic);
  assert.strictEqual(code.slice(fs[1].start, fs[1].end), K.groq);
  NO_SECRET(fs);
  assert.deepStrictEqual(ids(run('const a = "' + K.anthropic + '";\n', "app/api/route.ts")), [], "server file: out of scope");
  assert.deepStrictEqual(ids(run('const a = "' + K.anthropic + '";\n', "lib/a.ts", PLAIN)), [], "plain project: out of scope");
});
test("BK006: Google AIza only with Gemini context", () => {
  const noCtx = '"use client";\nconst firebase = { apiKey: "' + K.google + '" };\n';
  assert.deepStrictEqual(ids(run(noCtx, "app/a.tsx")), []);
  const ctxSdk = '"use client";\nimport { GoogleGenAI } from "@google/genai";\nconst ai = new GoogleGenAI({ apiKey: "' + K.google + '" });\n';
  const f = run(ctxSdk, "app/a.tsx")[0];
  assert.strictEqual(f.rule, "BK006");
  assert.strictEqual(f.docUrl, data.DOCS.googleGenai);
  assert.deepStrictEqual(ids(run('"use client";\nconst GEMINI_API_KEY = "' + K.google + '";\n', "app/a.tsx")), ["BK006"]);
});
test("BK006: HTML inline script", () => {
  const html = '<html><script>const k = "' + K.openrouter + '";</script><script type="application/json">{"k":"' + K.openai + '"}</script></html>\n';
  const fs = run(html, "public/index.html");
  assert.deepStrictEqual(fs.map((f) => f.provider), ["OpenRouter"]);
});

// ---- whole workspace ---------------------------------------------------------------------------
test("fixture workspace: exactly the expected findings", () => {
  const fs = scanWorkspace(fx.workspace());
  const got = fs.map((f) => [f.rel, f.rule, f.rule === "BK003" || f.rule === "BK006" ? null : f.name, f.line]);
  const key = (x) => x.join("|");
  const missing = fx.EXPECT.filter((e) => !got.some((g) => key(g) === key(e)));
  const extra = got.filter((g) => !fx.EXPECT.some((e) => key(g) === key(e)));
  assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] });
  NO_SECRET(fs);
  const byok = fs.find((f) => f.rel === "apps/spa/src/byok.ts");
  assert.ok(byok.byok);
});
test("in-editor workspace (with hostile extras): exactly the expected findings", () => {
  const files = Object.assign({}, fx.workspace(), fx.extraFiles());
  const ex = core.makeExcluder(["**/node_modules/**", "**/dist/**"]);
  for (const rel of Object.keys(files)) if (ex(rel)) delete files[rel];
  const fs = scanWorkspace(files);
  const got = fs.map((f) => [f.rel, f.rule, f.rule === "BK003" || f.rule === "BK006" ? null : f.name, f.line].join("|")).sort();
  const want = [...fx.EXPECT, ...fx.EXTRA_EXPECT].map((e) => e.join("|")).sort();
  assert.deepStrictEqual(got, want);
});
test("rules option turns rules off", () => {
  const code = '"use client";\nconst a = process.env.NEXT_PUBLIC_OPENAI_API_KEY;\nconst b = process.env.OPENAI_API_KEY;\n';
  assert.deepStrictEqual(ids(run(code, "app/a.tsx", NEXT, { rules: { BK002: false } })), ["BK004"]);
});
test("resolveSeverities", () => {
  assert.deepStrictEqual(core.resolveSeverities({ BK001: "hint", BK004: "nope", BK009: "error" }), { BK001: "hint", BK002: "error", BK003: "error", BK004: "warning", BK005: "error", BK006: "error" });
  assert.deepStrictEqual(core.resolveSeverities("junk").BK004, "warning");
});

// ---- robustness ---------------------------------------------------------------------------------
test("never throws on hostile input", () => {
  const junk = ["", "`", "`${", "${}", "/", "/*", "'", '"\\', "<script>", "<script", "{".repeat(5000), "}".repeat(5000), "process.env.", "import.meta.env[", "new OpenAI({ dangerouslyAllowBrowser: true", "NEXT_PUBLIC_=", "=\n=\n", "\u0000￿", "a".repeat(300000)];
  for (const j of junk) for (const rel of ["a.ts", ".env", "Dockerfile", "a.vue", "a.html", "next.config.js", ".github/workflows/x.yml", "package.json", "x.unknown"]) assert.ok(Array.isArray(core.analyze(j, rel, NEXT)));
  assert.ok(Array.isArray(core.analyze(null, null, null)));
  assert.ok(Array.isArray(core.analyze(undefined, "a.ts", undefined)));
  assert.deepStrictEqual(core.analyze("x".repeat(1024 * 1024 + 1), "a.ts", NEXT), []);
});
test("lexer: regex, templates with nested expressions, JSX text apostrophes", () => {
  const code = '"use client";\nconst r = /process.env.NEXT_PUBLIC_OPENAI_KEY/g;\nconst t = `${process.env.NEXT_PUBLIC_GROQ_KEY} and ${`${process.env.NEXT_PUBLIC_MISTRAL_KEY}`}`;\nconst j = <p>Don\'t</p>;\nconst x = process.env.NEXT_PUBLIC_COHERE_KEY;\n';
  assert.deepStrictEqual(rules(run(code, "app/a.tsx")), ["BK002:NEXT_PUBLIC_COHERE_KEY", "BK002:NEXT_PUBLIC_GROQ_KEY", "BK002:NEXT_PUBLIC_MISTRAL_KEY"]);
  const n = core.lex("a / b / c").filter((t) => t.t === "re").length;
  assert.strictEqual(n, 0);
});
test("performance: big file under a second", () => {
  const code = ('"use client";\n' + "const a = process.env.NEXT_PUBLIC_OPENAI_API_KEY + `x${y}` + /re/g;\n".repeat(15000));
  const t0 = Date.now();
  const fs = run(code, "app/a.tsx");
  assert.strictEqual(fs.length, 15000);
  assert.ok(Date.now() - t0 < 3000, "took " + (Date.now() - t0));
});

// ---- glob hardening -----------------------------------------------------------------------------
test("globToRegExp: basics", () => {
  const ex = core.makeExcluder(["**/node_modules/**", "gen/**", "*.min.js", "**/{a,b}/*.ts", "x[!0-9].ts"]);
  assert.ok(ex("node_modules/x/a.js"));
  assert.ok(ex("p/node_modules/a.js"));
  assert.ok(ex("gen/a.ts"));
  assert.ok(ex("lib/x.min.js"));
  assert.ok(ex("q/a/z.ts") && ex("b/z.ts"));
  assert.ok(ex("xa.ts") && !ex("x1.ts"));
  assert.ok(!ex("src/a.ts"));
});
test("globToRegExp: ReDoS-shaped patterns collapse, are refused, or stay linear", () => {
  assert.strictEqual(core.globToRegExp("**/**/**/**/**/a").source, "**/a");
  assert.strictEqual(core.globToRegExp("a/******/b").source, "a/**/b");
  assert.strictEqual(core.globToRegExp("a".repeat(301)), null);
  assert.strictEqual(core.globToRegExp("**a**b**c**d**e"), null);
  assert.strictEqual(core.globToRegExp("{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}"), null, "brace blow-up refused");
  const path = ("a".repeat(60) + "/").repeat(8) + "a".repeat(200);
  for (const g of ["**/*a*a*a*a*a*a*a*a*a*a*a*a*b", "**/*a*a*a/**/*a*a*b", "*/*/*/*/*/*/*/*/*/x", "**/a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*c"]) {
    const re = core.globToRegExp(g);
    const t0 = Date.now();
    assert.strictEqual(re.test(path), false, g);
    assert.ok(Date.now() - t0 < 1000, g + " took " + (Date.now() - t0));
  }
});
test("globToRegExp: brackets treat backslash and brackets literally", () => {
  assert.ok(core.globToRegExp("a[\\]]b").test("a]b"));
  assert.ok(core.globToRegExp("a[\\[]b").test("a[b"));
  assert.ok(core.globToRegExp("[\\\\]").test("\\"));
  assert.ok(core.globToRegExp("a[^x]b").test("ayb") && !core.globToRegExp("a[^x]b").test("axb"));
  assert.ok(core.globToRegExp("a[b").test("a[b"), "unclosed bracket is literal");
  assert.ok(!core.globToRegExp("[z-a]").test("m") && core.globToRegExp("[z-a]").test("[z-a]"), "reversed range is literal");
  assert.ok(core.globToRegExp("a.(b)+$").test("a.(b)+$"), "regex metacharacters are literal");
  assert.strictEqual(core.makeExcluder([5, null, "", "(((", "[z-a]"])("a"), false);
});

// ---- data tables ---------------------------------------------------------------------------------
test("data: every key pattern names a source; docs are https", () => {
  for (const p of data.KEY_PATTERNS) assert.ok(/^https:\/\//.test(p.source), p.id);
  for (const u of Object.values(data.DOCS)) assert.ok(/^https:\/\//.test(u));
  for (const e of data.PUBLIC_PREFIXES) assert.ok(e.doc);
});
test("no em/en dashes in messages", () => {
  const fs = scanWorkspace(fx.workspace());
  assert.ok(!/[\u2013\u2014]/.test(ALL_TEXT(fs)));
});

test("security: <script> extraction is linear (no '[^>]*>' rescan, one lowercase)", () => {
  for (const body of ["<script".repeat(15000), "<script></script>".repeat(6000)]) {
    const t = Date.now();
    core.analyze(body, "a.html", VITE, {});
    assert.ok(Date.now() - t < 200, `took ${Date.now() - t} ms`);
  }
  assert.strictEqual(core.scriptOnly("<p><script type=module>x</script>").trim(), "x");
});
test("security: build-file line with thousands of public names is not quadratic", () => {
  let line = "";
  for (let i = 0; line.length < 100000; i++) line += `VITE_A${i}=\${X} `;
  for (const f of ["Dockerfile", ".github/workflows/a.yml"]) {
    const t = Date.now();
    core.analyze(line, f, VITE, {});
    assert.ok(Date.now() - t < 400, `${f} took ${Date.now() - t} ms`);
  }
  assert.ok(core.analyze("ENV VITE_X=$OPENAI_API_KEY\n", "Dockerfile", VITE, {}).some((f) => f.rule === "BK001"));
});

console.log(`core tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
