"use strict";

// BrowserKey core: finds AI provider API keys that reach browser (or app) bundles.
// Pure functions, no vscode import, zero dependencies. Never throws on any input.
// Secret values are never put into a finding: only the documented key prefix is shown.

const data = require("./data");

const RULES = {
  BK001: { title: "Public-prefixed variable holds an AI provider key", default: "error" },
  BK002: { title: "Public AI key read in client code", default: "error" },
  BK003: { title: "SDK client created with dangerouslyAllowBrowser: true", default: "error" },
  BK004: { title: "Server-only AI key read in a client-side file", default: "warning" },
  BK005: { title: "AI key inlined into the bundle by the build config", default: "error" },
  BK006: { title: "Hardcoded AI provider key in frontend code", default: "error" },
};
const RULE_IDS = Object.keys(RULES);
const SEVERITIES = ["error", "warning", "information", "hint", "off"];
const MAX_TEXT = 1024 * 1024;
const MAX_NAME = 128;
const MAX_IGNORE = 200;

// ---------------------------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------------------------

function resolveSeverities(raw) {
  const out = {};
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  for (const id of RULE_IDS) out[id] = SEVERITIES.includes(r[id]) ? r[id] : RULES[id].default;
  return out;
}

/** Severity of one finding: BK003 for a user-supplied key is information unless BK003 is set explicitly. */
function findingSeverity(f, raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (SEVERITIES.includes(r[f.rule])) return r[f.rule];
  if (f.rule === "BK003" && f.byok) return "information";
  return RULES[f.rule] ? RULES[f.rule].default : "warning";
}

/** User regex for ignored names: capped length, compiled safely; null when empty or invalid. */
function compileIgnore(src) {
  if (typeof src !== "string") return null;
  const s = src.trim();
  if (!s || s.length > MAX_IGNORE) return null;
  try {
    return new RegExp(s);
  } catch (_) {
    return null;
  }
}

function sanitizePrefixes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) if (typeof p === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(p.trim())) out.push(p.trim());
  return [...new Set(out)].slice(0, 50);
}

// ---------------------------------------------------------------------------------------------
// Names and values
// ---------------------------------------------------------------------------------------------

const SECRET = new Set(data.SECRET_WORDS);
const NON_SECRET = new Set(data.NON_SECRET_SUFFIXES);
const PROVIDER_LIST = Object.keys(data.PROVIDER_WORDS).sort((a, b) => b.length - a.length);

function toUpperSnake(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/** { provider } when the variable name says "AI provider credential", else null. */
function aiKeyName(name) {
  if (typeof name !== "string" || !name || name.length > MAX_NAME) return null;
  const parts = toUpperSnake(name).split("_").filter(Boolean);
  if (!parts.length || NON_SECRET.has(parts[parts.length - 1])) return null;
  let provider = null;
  let secret = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (SECRET.has(p)) secret = true;
    if (!provider && Object.prototype.hasOwnProperty.call(data.PROVIDER_WORDS, p)) provider = data.PROVIDER_WORDS[p];
    if (!provider) {
      for (const [a, b, label] of data.PROVIDER_PAIRS) if (p === a && parts[i + 1] === b) provider = label;
    }
    // Concatenated forms: OPENAIKEY, OPENAIAPIKEY, GEMINITOKEN.
    for (const w of PROVIDER_LIST) {
      if (p.length > w.length && p.startsWith(w)) {
        const rest = p.slice(w.length);
        if (SECRET.has(rest) || rest === "APIKEY") {
          if (!provider) provider = data.PROVIDER_WORDS[w];
          secret = true;
          break;
        }
      }
    }
  }
  return provider && secret ? { provider } : null;
}

const KEY_RES = data.KEY_PATTERNS.map((p) => Object.assign({}, p, {
  full: new RegExp("^(?:" + p.re + ")$"),
  any: new RegExp("(?<![A-Za-z0-9_-])(?:" + p.re + ")(?![A-Za-z0-9_-])", "g"),
}));

function unquote(v) {
  const s = String(v).trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'" || s[0] === "`") && s[s.length - 1] === s[0]) return s.slice(1, -1);
  return s;
}

/** { provider, shown } when the whole value is an AI key (placeholders never count). */
function aiKeyValue(value, googleContext) {
  const v = unquote(value).trim();
  if (!v || v.length > 400 || data.PLACEHOLDER_RE.test(v)) return null;
  for (const p of KEY_RES) {
    if (p.needsContext && !googleContext) continue;
    if (p.full.test(v)) return { provider: p.provider, shown: p.shown(v), id: p.id };
  }
  return null;
}

/** Keys inside a longer string: [{ index, length, provider, shown, id }]. */
function findKeysInString(s, googleContext) {
  const out = [];
  if (typeof s !== "string" || s.length < 8 || s.length > 200000) return out;
  const taken = [];
  for (const p of KEY_RES) {
    if (p.needsContext && !googleContext) continue;
    p.any.lastIndex = 0;
    let m;
    while ((m = p.any.exec(s))) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      if (data.PLACEHOLDER_RE.test(m[0])) continue;
      taken.push([start, end]);
      out.push({ index: start, length: m[0].length, provider: p.provider, shown: p.shown(m[0]), id: p.id });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** The masked form shown to people: documented prefix plus asterisks, never more. */
function mask(shown) {
  return `${shown}****`;
}

// ---------------------------------------------------------------------------------------------
// Files, frameworks and projects
// ---------------------------------------------------------------------------------------------

function basename(rel) {
  const p = String(rel).replace(/\\/g, "/");
  return p.slice(p.lastIndexOf("/") + 1);
}
function dirname(rel) {
  const p = String(rel).replace(/\\/g, "/");
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

const CI_FILES = /^(?:\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|cloudbuild\.ya?ml|amplify\.ya?ml|buildspec\.ya?ml|\.travis\.ya?ml|render\.ya?ml|app\.ya?ml)$/i;

/** Kind of a workspace file, or null when BrowserKey does not read it. */
function kindFromPath(rel) {
  const p = String(rel || "").replace(/\\/g, "/");
  const b = basename(p);
  if (!b) return null;
  if (b === "package.json") return "package";
  if (b === ".env" || /^\.env\./.test(b) || /\.env$/.test(b)) {
    if (/\.(?:js|ts|mjs|cjs|json|py|sh)$/.test(b)) return null;
    return "env";
  }
  if (/^(?:Dockerfile|Containerfile)(?:\..+)?$/.test(b) || /\.(?:Dockerfile|dockerfile)$/.test(b)) return "docker";
  if (/^(?:docker-)?compose(?:[.-].*)?\.ya?ml$/i.test(b)) return "compose";
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(p) || /(^|\/)\.circleci\/config\.ya?ml$/i.test(p) || CI_FILES.test(b)) return "ci";
  if (b === "netlify.toml") return "toml";
  if (/\.d\.[cm]?ts$/.test(b)) return null;
  if (/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(b)) return "js";
  if (/\.vue$/.test(b)) return "vue";
  if (/\.svelte$/.test(b)) return "svelte";
  if (/\.html?$/.test(b)) return "html";
  return null;
}

/** Files that only feed the project context (frameworks, envPrefix): package.json, vite/svelte config. */
function isContextFile(rel) {
  const b = basename(rel);
  return b === "package.json" || /^(?:vite|vitest|svelte)\.config\.[cm]?[jt]s$/.test(b);
}

function frameworksFromPackage(text) {
  const fw = { next: false, cra: false, vite: false, viteSpa: false, sveltekit: false, astro: false, nuxt: false, gatsby: false, expo: false };
  let pkg;
  try {
    pkg = JSON.parse(String(text));
  } catch (_) {
    return fw;
  }
  if (!pkg || typeof pkg !== "object") return fw;
  const deps = {};
  for (const k of ["dependencies", "devDependencies", "peerDependencies"]) {
    if (pkg[k] && typeof pkg[k] === "object") Object.assign(deps, pkg[k]);
  }
  const has = (d) => Object.prototype.hasOwnProperty.call(deps, d);
  for (const [dep, id] of Object.entries(data.FRAMEWORK_DEPS)) if (has(dep)) fw[id] = true;
  fw.viteSpa = fw.vite && !data.VITE_SSR_DEPS.some(has);
  return fw;
}

/** String-literal envPrefix (Vite) and publicPrefix (SvelteKit) values in a config file. */
function extractConfigPrefixes(text) {
  const out = [];
  const T = lexSafe(text);
  for (let k = 0; k < T.length; k++) {
    if (!isKeyAt(T, k, "envPrefix") && !isKeyAt(T, k, "publicPrefix")) continue;
    const v = T[k + 2];
    if (!v) continue;
    if (v.t === "str") out.push(v.v);
    else if (v.v === "[") {
      for (let j = k + 3; j < T.length && T[j].v !== "]"; j++) if (T[j].t === "str") out.push(T[j].v);
    }
  }
  return sanitizePrefixes(out);
}

function prefixEntries(fw, extra) {
  const out = [];
  for (const e of data.PUBLIC_PREFIXES) {
    if (e.always || (fw && e.frameworks && e.frameworks.some((f) => fw[f]))) out.push(e);
  }
  for (const p of extra || []) {
    if (!out.some((e) => e.prefix === p)) out.push({ prefix: p, framework: "your build config", always: true, where: "browser", doc: data.DOCS.viteEnvPrefix });
  }
  return out.sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * Build the scan context.
 * packages: [{ dir, text }] package.json files (dir workspace-relative, "" for the root).
 * configs:  [{ rel, text }] vite/svelte config files (string-literal envPrefix / publicPrefix).
 */
function makeContext(opts) {
  const o = opts || {};
  const extra = sanitizePrefixes(o.extraPublicPrefixes);
  const projects = [];
  for (const p of Array.isArray(o.packages) ? o.packages : []) {
    if (!p || typeof p.dir !== "string") continue;
    projects.push({ dir: p.dir.replace(/\\/g, "/").replace(/\/+$/, ""), fw: frameworksFromPackage(p.text), own: [] });
  }
  projects.sort((a, b) => b.dir.length - a.dir.length);
  for (const c of Array.isArray(o.configs) ? o.configs : []) {
    if (!c || typeof c.rel !== "string") continue;
    const proj = projectFor(c.rel, { projects });
    if (proj) proj.own.push(...extractConfigPrefixes(c.text));
  }
  for (const p of projects) p.prefixes = prefixEntries(p.fw, [...p.own, ...extra]);
  const union = [];
  for (const e of prefixEntries(null, extra)) union.push(e);
  for (const p of projects) for (const e of p.prefixes) if (!union.some((u) => u.prefix === e.prefix)) union.push(e);
  union.sort((a, b) => b.prefix.length - a.prefix.length);
  return { projects, extra, union, ignore: compileIgnore(o.ignoreNames), aiValueNames: new Map() };
}

function projectFor(rel, ctx) {
  const p = String(rel).replace(/\\/g, "/");
  for (const proj of (ctx && ctx.projects) || []) {
    if (proj.dir === "" || p === proj.dir || p.startsWith(proj.dir + "/")) return proj;
  }
  return null;
}

function publicPrefixOf(name, prefixes) {
  for (const e of prefixes) if (name.length > e.prefix.length && name.startsWith(e.prefix)) return e;
  return null;
}

/** Remember public variables whose VALUE is an AI key (from .env / CI files), for BK002 in code. */
function noteValueFindings(ctx, rel, findings) {
  if (!ctx || !Array.isArray(findings)) return;
  for (const f of findings) {
    if (f.rule === "BK001" && f.byValue && f.name && !ctx.aiValueNames.has(f.name)) ctx.aiValueNames.set(f.name, { provider: f.provider, file: basename(rel) });
  }
}

// ---------------------------------------------------------------------------------------------
// JS / TS lexer (comments dropped, strings and template chunks kept with raw offsets)
// ---------------------------------------------------------------------------------------------

const REGEX_KW = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);
const isIdStart = (c) => /[A-Za-z_$\u0080-￿]/.test(c);
const isIdPart = (c) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

function lex(text) {
  const s = String(text);
  const n = s.length;
  const toks = [];
  const tplStack = [];
  let braceDepth = 0;
  let i = 0;
  if (s.startsWith("#!")) while (i < n && s[i] !== "\n") i++;
  const push = (t, v, start, end, extra) => toks.push(Object.assign({ t, v, s: start, e: end }, extra));
  const regexAllowed = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.t === "num" || p.t === "str" || p.t === "re") return false;
    if (p.t === "id") return REGEX_KW.has(p.v);
    return !(p.v === ")" || p.v === "]" || p.v === "}");
  };
  const readTemplate = () => {
    const start = i;
    while (i < n) {
      const c = s[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        push("str", s.slice(start, i), start, i, { raw: s.slice(start, i), rs: start, tpl: true });
        i++;
        return "end";
      }
      if (c === "$" && s[i + 1] === "{") {
        push("str", s.slice(start, i), start, i, { raw: s.slice(start, i), rs: start, tpl: true });
        i += 2;
        return "expr";
      }
      i++;
    }
    push("str", s.slice(start, n), start, n, { raw: s.slice(start, n), rs: start, tpl: true });
    return "end";
  };
  while (i < n) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === " " || c === "﻿") {
      i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      while (i < n && s[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const e = s.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === "<" && s.startsWith("<!--", i)) {
      while (i < n && s[i] !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i++;
      while (i < n && s[i] !== c && s[i] !== "\n") i += s[i] === "\\" ? 2 : 1;
      const raw = s.slice(start + 1, Math.min(i, n));
      push("str", raw.replace(/\\(.)/g, "$1"), start, Math.min(i + 1, n), { raw, rs: start + 1 });
      if (i < n && s[i] === c) i++;
      continue;
    }
    if (c === "`") {
      i++;
      if (readTemplate() === "expr") {
        tplStack.push(braceDepth);
        braceDepth = 0;
      }
      continue;
    }
    if (c === "}" && tplStack.length && braceDepth === 0) {
      braceDepth = tplStack.pop();
      i++;
      if (readTemplate() === "expr") {
        tplStack.push(braceDepth);
        braceDepth = 0;
      }
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(s[i + 1] || ""))) {
      const start = i;
      i++;
      while (i < n && /[0-9A-Za-z_.]/.test(s[i])) i++;
      push("num", s.slice(start, i), start, i);
      continue;
    }
    if (isIdStart(c) || (c === "#" && isIdStart(s[i + 1] || ""))) {
      const start = i;
      i++;
      while (i < n && isIdPart(s[i])) i++;
      push("id", s.slice(start, i), start, i);
      continue;
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let cls = false;
      let ok = false;
      while (j < n && s[j] !== "\n") {
        const d = s[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) {
          ok = true;
          break;
        }
        j++;
      }
      if (ok) {
        j++;
        while (j < n && /[a-z]/.test(s[j])) j++;
        push("re", s.slice(i, j), i, j);
        i = j;
        continue;
      }
    }
    if (s.startsWith("...", i)) {
      push("p", "...", i, i + 3);
      i += 3;
      continue;
    }
    if (c === "?" && s[i + 1] === "." && !/[0-9]/.test(s[i + 2] || "")) {
      push("p", ".", i, i + 2);
      i += 2;
      continue;
    }
    if (c === "=" && s[i + 1] === ">") {
      push("p", "=>", i, i + 2);
      i += 2;
      continue;
    }
    if ((c === "=" || c === "!") && s[i + 1] === "=") {
      const len = s[i + 2] === "=" ? 3 : 2;
      push("p", s.slice(i, i + len), i, i + len);
      i += len;
      continue;
    }
    if (c === "{") braceDepth++;
    else if (c === "}" && braceDepth > 0) braceDepth--;
    push("p", c, i, i + 1);
    i++;
  }
  return toks;
}

function lexSafe(text) {
  try {
    return lex(String(text || "").slice(0, MAX_TEXT));
  } catch (_) {
    return [];
  }
}

/** Keep only <script> bodies (Vue, Svelte, HTML); everything else becomes spaces so offsets stay valid. */
function scriptOnly(text) {
  const s = String(text);
  const out = s.replace(/[^\n]/g, " ").split("");
  // Linear: find "<script", then the next ">" with indexOf (a "[^>]*>" regex rescans to the end of
  // the text for every "<script" when no ">" follows, which is quadratic), lowercase only once.
  const lower = s.toLowerCase();
  const re = /<script\b/gi;
  let m;
  while ((m = re.exec(s))) {
    const gt = s.indexOf(">", m.index + m[0].length);
    if (gt < 0) break;
    const attrs = s.slice(m.index + m[0].length, gt);
    const bodyStart = gt + 1;
    const close = lower.indexOf("</script", bodyStart);
    const bodyEnd = close < 0 ? s.length : close;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    const jsType = !type || /module|javascript|jsx|tsx?|typescript|babel/i.test(type[1]);
    if (jsType && !/\bsrc\s*=/i.test(attrs)) for (let k = bodyStart; k < bodyEnd; k++) out[k] = s[k];
    re.lastIndex = bodyEnd;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------------------------

const isP = (t, v) => !!t && t.t === "p" && t.v === v;
const isId = (t, v) => !!t && t.t === "id" && (v === undefined || t.v === v);
const keyName = (t) => (t && (t.t === "id" || (t.t === "str" && !t.tpl)) ? t.v : null);

/** T[k] is an object key `name:` (after "{" or ","). */
function isKeyAt(T, k, name) {
  const t = T[k];
  return !!t && keyName(t) === name && isP(T[k + 1], ":") && (isP(T[k - 1], "{") || isP(T[k - 1], ","));
}

function matchClose(T, open) {
  const o = T[open].v;
  const c = o === "{" ? "}" : o === "[" ? "]" : ")";
  let d = 0;
  for (let j = open; j < T.length; j++) {
    if (T[j].t !== "p") continue;
    if (T[j].v === o) d++;
    else if (T[j].v === c && --d === 0) return j;
  }
  return T.length;
}

function enclosingOpen(T, k, ch) {
  const close = ch === "{" ? "}" : ch === "[" ? "]" : ")";
  let d = 0;
  for (let j = k - 1; j >= 0; j--) {
    if (T[j].t !== "p") continue;
    if (T[j].v === close) d++;
    else if (T[j].v === ch) {
      if (d === 0) return j;
      d--;
    }
  }
  return -1;
}

/** Entries of the object literal opened at T[open]: [{ key, keyIdx, from, to }] (value tokens [from, to)). */
function objectEntries(T, open) {
  const out = [];
  if (!isP(T[open], "{")) return out;
  const end = matchClose(T, open);
  let j = open + 1;
  while (j < end) {
    let k = j;
    let d = 0;
    while (k < end) {
      const t = T[k];
      if (t.t === "p") {
        if (t.v === "{" || t.v === "[" || t.v === "(") d++;
        else if (t.v === "}" || t.v === "]" || t.v === ")") d--;
        else if (t.v === "," && d === 0) break;
      }
      k++;
    }
    let key = null;
    let keyIdx = j;
    let from = k;
    if (isP(T[j], "[") && T[j + 1] && T[j + 1].t === "str" && isP(T[j + 2], "]") && isP(T[j + 3], ":")) {
      key = T[j + 1].v;
      keyIdx = j + 1;
      from = j + 4;
    } else if (keyName(T[j]) !== null && isP(T[j + 1], ":")) {
      key = keyName(T[j]);
      from = j + 2;
    } else if (isId(T[j]) && k === j + 1) {
      key = T[j].v; // shorthand
      from = k;
    }
    if (key !== null) out.push({ key, keyIdx, from, to: k });
    j = k + 1;
  }
  return out;
}

function hasDirective(T, d) {
  let j = 0;
  while (T[j] && T[j].t === "str" && !T[j].tpl) {
    if (T[j].v === d) return true;
    j++;
    if (isP(T[j], ";")) j++;
  }
  return false;
}

/** Env reads: [{ name, idx, source }] where source is process.env, import.meta.env, a module, or nuxt. */
function envRefs(T) {
  const refs = [];
  const envObjects = new Map(); // local ident -> "public-module" | "private-module"
  const runtimeConfigs = new Set();
  const MODULES = {
    "$env/static/public": "public-module",
    "$env/dynamic/public": "public-module",
    "$app/env/public": "public-module",
    "$env/static/private": "private-module",
    "$env/dynamic/private": "private-module",
    "$app/env/private": "private-module",
  };
  // Imports from SvelteKit env modules.
  for (let k = 0; k < T.length; k++) {
    if (!isId(T[k], "import") || !isP(T[k + 1], "{")) continue;
    const close = matchClose(T, k + 1);
    if (!isId(T[close + 1], "from") || !T[close + 2] || T[close + 2].t !== "str") continue;
    const vis = MODULES[T[close + 2].v];
    if (!vis) continue;
    for (let j = k + 2; j < close; j++) {
      if (!isId(T[j]) || (j > k + 2 && !isP(T[j - 1], ","))) continue;
      const imported = T[j].v;
      const local = isId(T[j + 1], "as") && isId(T[j + 2]) ? T[j + 2].v : imported;
      if (imported === "env") envObjects.set(local, vis);
      else refs.push({ name: imported, idx: j, source: vis });
    }
  }
  const member = (j) => {
    if (isP(T[j], ".") && isId(T[j + 1])) return j + 1;
    if (isP(T[j], ".") && isP(T[j + 1], "[")) j++;
    if (isP(T[j], "[") && T[j + 1] && T[j + 1].t === "str" && !T[j + 1].tpl && isP(T[j + 2], "]")) return j + 1;
    return -1;
  };
  const destructure = (k, source) => {
    if (!isP(T[k - 1], "=") || !isP(T[k - 2], "}")) return;
    const open = enclosingOpen(T, k - 2, "{");
    if (open < 0) return;
    for (const e of objectEntries(T, open)) if (/^[A-Za-z_$][\w$]*$/.test(e.key)) refs.push({ name: e.key, idx: e.keyIdx, source });
  };
  for (let k = 0; k < T.length; k++) {
    const t = T[k];
    if (t.t !== "id" || isP(T[k - 1], ".")) continue;
    let after = -1;
    let source = null;
    if (t.v === "process" && isP(T[k + 1], ".") && isId(T[k + 2], "env")) {
      after = k + 3;
      source = "process.env";
    } else if (t.v === "import" && isP(T[k + 1], ".") && isId(T[k + 2], "meta") && isP(T[k + 3], ".") && isId(T[k + 4], "env")) {
      after = k + 5;
      source = "import.meta.env";
    } else if (envObjects.has(t.v)) {
      after = k + 1;
      source = envObjects.get(t.v);
    } else if (t.v === "useRuntimeConfig" && isP(T[k + 1], "(") && isP(T[k + 2], ")") && isP(T[k + 3], ".") && isId(T[k + 4], "public")) {
      const m = member(k + 5);
      if (m >= 0) refs.push({ name: T[m].v, idx: m, source: "nuxt-public" });
      continue;
    } else if (runtimeConfigs.has(t.v) && isP(T[k + 1], ".") && isId(T[k + 2], "public")) {
      const m = member(k + 3);
      if (m >= 0) refs.push({ name: T[m].v, idx: m, source: "nuxt-public" });
      continue;
    } else if (isId(T[k + 2], "useRuntimeConfig") && isP(T[k + 1], "=") && isP(T[k + 3], "(")) {
      runtimeConfigs.add(t.v);
      continue;
    } else continue;
    const m = member(after);
    if (m >= 0) refs.push({ name: T[m].v, idx: m, source });
    else if (source === "process.env" || source === "import.meta.env") destructure(k, source);
  }
  return refs;
}

/** Names of AI-key-looking env vars referenced in T[from, to): process.env.X, env.X, secrets.X. */
function aiRefsIn(T, from, to) {
  const out = [];
  for (let j = from; j < to; j++) {
    const t = T[j];
    if (isId(t) && isP(T[j - 1], ".") && aiKeyName(t.v)) out.push({ name: t.v, idx: j });
    else if (t && t.t === "str" && !t.tpl && isP(T[j - 1], "[") && aiKeyName(t.v)) out.push({ name: t.v, idx: j });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Classification of JS files
// ---------------------------------------------------------------------------------------------

function projRelOf(rel, proj) {
  const p = String(rel).replace(/\\/g, "/");
  return proj && proj.dir ? p.slice(proj.dir.length + 1) : p;
}

function serverReason(rel, proj, T) {
  const fw = (proj && proj.fw) || {};
  const pr = projRelOf(rel, proj);
  const b = basename(pr);
  const dirs = pr.split("/").slice(0, -1);
  if (hasDirective(T, "use server")) return '"use server" file';
  if (/\.server\.[^.]+$/.test(b) || /^\+server\.[cm]?[jt]s$/.test(b) || /\+api\.[cm]?[jt]sx?$/.test(b)) return "server file";
  if (/\.config\.[cm]?[jt]s$/.test(b) || /^gatsby-(?:node|config|ssr)\./.test(b)) return "build config";
  if (dirs.some((d) => ["server", "functions", "netlify", "supabase", "scripts", "middleware", "workers"].includes(d))) return "server folder";
  if (fw.next && (/^(?:route|middleware|instrumentation)\.[cm]?[jt]sx?$/.test(b) || /(?:^|\/)pages\/api\//.test(pr) || /(?:^|\/)app\/(?:.*\/)?api\//.test(pr))) return "Next.js server route";
  if (fw.gatsby && /^src\/api\//.test(pr)) return "Gatsby function";
  return null;
}

/** Why a file runs in the browser (or app), or null when unknown / server. */
function clientReason(rel, kind, proj, T, browserFlag) {
  if (kind === "html") return "an HTML page";
  if (serverReason(rel, proj, T)) return null;
  const fw = (proj && proj.fw) || {};
  const pr = projRelOf(rel, proj);
  const b = basename(pr);
  if (hasDirective(T, "use client")) return 'a "use client" component';
  if (kind === "vue") return "a Vue component";
  if (kind === "svelte") return "a Svelte component";
  if (/\.client\.[cm]?[jt]sx?$/.test(b)) return "a .client file";
  if (fw.sveltekit && /^\+(?:page|layout)\.[jt]s$/.test(b)) return "a SvelteKit universal load file (also runs in the browser)";
  if (fw.sveltekit && /^hooks\.client\./.test(b)) return "SvelteKit client hooks";
  if (fw.viteSpa && /^src\//.test(pr)) return "Vite single-page app code";
  if (fw.cra && /^src\//.test(pr)) return "Create React App code";
  if (fw.gatsby && /^src\//.test(pr)) return "Gatsby page code";
  if (fw.expo) return "Expo app code";
  if (browserFlag) return "browser SDK code (dangerouslyAllowBrowser)";
  return null;
}

function frameworkDoc(proj) {
  const fw = (proj && proj.fw) || {};
  if (fw.next) return data.DOCS.next;
  if (fw.nuxt) return data.DOCS.nuxt;
  if (fw.sveltekit) return data.DOCS.sveltekit;
  if (fw.astro) return data.DOCS.astro;
  if (fw.expo) return data.DOCS.expo;
  if (fw.gatsby) return data.DOCS.gatsby;
  if (fw.cra) return data.DOCS.cra;
  if (fw.vite) return data.DOCS.vite;
  return data.DOCS.keySafety;
}

function where(e) {
  return e && e.where === "app bundle" ? "app bundle" : "browser";
}
function shippedPhrase(e) {
  return where(e) === "browser" ? "is bundled into the browser" : "is shipped in the app bundle";
}
const SERVER_ADVICE = "Keep the key in a server-only variable and call the provider from a server route (API route, Route Handler, server action or edge function) that the page calls instead.";

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

function lineStarts(text) {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}
function posAt(starts, off) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: off - starts[lo] };
}

function makeEmitter(text, rel, ctx, opts) {
  const starts = lineStarts(text);
  const rules = (opts && opts.rules) || {};
  const out = [];
  const seen = new Set();
  const emit = (rule, start, end, f) => {
    if (rules[rule] === false) return;
    if (f.name && ctx.ignore && f.name.length <= MAX_NAME && ctx.ignore.test(f.name)) return;
    const key = `${rule}:${start}`;
    if (seen.has(key)) return;
    seen.add(key);
    const a = posAt(starts, start);
    const b = posAt(starts, Math.max(start, end));
    out.push(Object.assign({ id: key, rule, line: a.line, character: a.character, endLine: b.line, endCharacter: b.character, start, end }, f));
  };
  return { out, emit };
}

/** Analyse one file. Returns findings (never throws). */
function analyze(text, rel, ctx, opts) {
  try {
    return analyzeInner(String(text || ""), String(rel || ""), ctx || makeContext({}), opts || {});
  } catch (_) {
    return [];
  }
}

function analyzeInner(text, rel, ctx, opts) {
  if (text.length > MAX_TEXT) return [];
  const kind = kindFromPath(rel);
  if (!kind || kind === "package") return [];
  const { out, emit } = makeEmitter(text, rel, ctx, opts);
  if (kind === "env") analyzeEnv(text, rel, ctx, emit);
  else if (kind === "docker" || kind === "compose" || kind === "ci" || kind === "toml") analyzeBuildFile(text, rel, kind, ctx, emit);
  else analyzeCode(text, rel, kind, ctx, emit);
  return out.sort((a, b) => a.start - b.start || a.rule.localeCompare(b.rule));
}

function bk001(emit, rel, name, start, e, why, extra) {
  const b = basename(rel);
  const provider = why.provider;
  let reason;
  if (why.kind === "name") reason = `The name says it is ${article(provider)} ${provider} key`;
  else if (why.kind === "value") reason = `Its value is ${article(provider)} ${provider} key (starts with ${why.shown}, the rest is masked)`;
  else reason = `It takes its value from ${why.ref}, ${article(provider)} ${provider} key`;
  emit("BK001", start, start + name.length, Object.assign({
    name,
    provider,
    byValue: why.kind === "value",
    short: `${name} in ${b} ${shippedPhrase(e)}`,
    message: `${name} has the ${e.prefix} prefix, so ${e.framework} inlines it into client code: it ends up in plain text in the ${where(e) === "browser" ? "JavaScript every visitor downloads" : "compiled app"}. ${reason}. ${SERVER_ADVICE}`,
    docUrl: e.doc,
  }, extra || {}));
}

function article(word) {
  return /^[AEIOU]/i.test(word) ? "an" : "a";
}

// ---- .env files --------------------------------------------------------------------------------

function analyzeEnv(text, rel, ctx, emit) {
  const proj = projectFor(rel, ctx);
  const prefixes = proj ? proj.prefixes : ctx.union;
  const lines = text.split("\n");
  const defined = new Set();
  const parsed = [];
  let off = 0;
  let inMulti = null;
  for (const line of lines) {
    const lineOff = off;
    off += line.length + 1;
    if (inMulti) {
      if (line.includes(inMulti)) inMulti = null;
      continue;
    }
    const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.]*)(\s*=\s*)(.*)$/.exec(line.replace(/\r$/, ""));
    if (!m) continue;
    const name = m[2];
    let value = m[4];
    const q = value[0];
    if (q === '"' || q === "'" || q === "`") {
      const close = value.indexOf(q, 1);
      if (close < 0) {
        inMulti = q;
        value = "";
      } else value = value.slice(1, close);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    defined.add(name);
    parsed.push({ name, value, start: lineOff + m[1].length });
  }
  for (const p of parsed) {
    const e = publicPrefixOf(p.name, prefixes);
    if (!e) continue;
    const why = whyAi(p.name, p.value);
    if (!why) continue;
    const stripped = p.name.slice(e.prefix.length);
    const fix = /^[A-Za-z_]/.test(stripped) && !defined.has(stripped)
      ? { title: `Rename to ${stripped} (server-only)`, edits: [{ start: p.start, end: p.start + p.name.length, expect: p.name, text: stripped }] }
      : undefined;
    bk001(emit, rel, p.name, p.start, e, why, fix ? { fix } : {});
  }
}

/** Why a public variable counts as an AI key: by name, by value, or by the variable it copies. */
function whyAi(name, value) {
  const byName = aiKeyName(name);
  if (byName) return { kind: "name", provider: byName.provider };
  const v = value == null ? "" : String(value);
  const byValue = aiKeyValue(v, false);
  if (byValue) return { kind: "value", provider: byValue.provider, shown: byValue.shown };
  const re = /secrets\.([A-Za-z_][A-Za-z0-9_]*)|vars\.([A-Za-z_][A-Za-z0-9_]*)|env\.([A-Za-z_][A-Za-z0-9_]*)|\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
  // Only the first 256 characters are searched for references: build files pass the rest of the line, and a
  // long line with thousands of public names would otherwise rescan it once per name (quadratic).
  const head = v.slice(0, 256);
  let m;
  while ((m = re.exec(head))) {
    const ref = m[1] || m[2] || m[3] || m[4];
    const r = aiKeyName(ref);
    if (r) return { kind: "ref", provider: r.provider, ref };
  }
  return null;
}

// ---- Dockerfile, compose, CI, netlify.toml ------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function analyzeBuildFile(text, rel, kind, ctx, emit) {
  const prefixes = ctx.union;
  if (!prefixes.length) return;
  const nameRe = new RegExp("(?<![A-Za-z0-9_])(?:" + prefixes.map((e) => escapeRe(e.prefix)).join("|") + ")[A-Za-z0-9_]+", "g");
  const done = new Set();
  let off = 0;
  for (const rawLine of text.split("\n")) {
    const lineOff = off;
    off += rawLine.length + 1;
    const line = rawLine.replace(/\r$/, "");
    if (/^\s*#/.test(line)) continue;
    let code = line;
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "#" && i > 0 && /\s/.test(line[i - 1])) {
        code = line.slice(0, i);
        break;
      }
    }
    nameRe.lastIndex = 0;
    let m;
    while ((m = nameRe.exec(code))) {
      const name = m[0];
      if (done.has(name)) continue;
      const e = publicPrefixOf(name, prefixes);
      if (!e) continue;
      // Bounded: a value is never longer than this, and the whole rest of a long line per name is quadratic.
      const rest = code.slice(m.index + name.length, m.index + name.length + 1024);
      const v = /^\s*(?:=|:)\s*(.*)$/.exec(rest);
      const why = whyAi(name, v ? v[1].trim() : "");
      if (!why) continue;
      done.add(name);
      bk001(emit, rel, name, lineOff + m.index, e, why);
    }
  }
}

// ---- JS / TS / Vue / Svelte / HTML -------------------------------------------------------------

function analyzeCode(text, rel, kind, ctx, emit) {
  const src = kind === "js" ? text : scriptOnly(text);
  const T = lexSafe(src);
  const proj = projectFor(rel, ctx);
  const prefixes = proj ? proj.prefixes : prefixEntries(null, ctx.extra);
  const b = basename(rel);
  const geminiFile = T.some((t) => t.t === "str" && (data.GEMINI_PACKAGES.includes(t.v) || /generativelanguage\.googleapis\.com/.test(t.v)));
  const browserFlags = findBrowserFlags(T);
  const client = clientReason(rel, kind, proj, T, browserFlags.length > 0);
  const server = kind === "html" ? null : serverReason(rel, proj, T);

  // BK003: dangerouslyAllowBrowser / anthropic-dangerous-direct-browser-access.
  for (const f of browserFlags) {
    const t = T[f.idx];
    emit("BK003", t.s, t.e, {
      name: f.label,
      provider: f.provider,
      byok: f.byok,
      short: f.short,
      message: f.message,
      docUrl: f.doc,
    });
  }

  // BK002 / BK004: env reads.
  for (const r of envRefs(T)) {
    const t = T[r.idx];
    const name = r.name;
    let pub = null;
    if (r.source === "public-module") pub = { prefix: "", framework: "SvelteKit", how: "it is imported from a public env module", doc: data.DOCS.sveltekit, where: "browser" };
    else if (r.source === "nuxt-public") pub = { prefix: "", framework: "Nuxt", how: "it is in runtimeConfig.public", doc: data.DOCS.nuxt, where: "browser" };
    else if (r.source !== "private-module") {
      const e = publicPrefixOf(name, prefixes);
      if (e) pub = Object.assign({ how: `it has the ${e.prefix} prefix` }, e);
    }
    if (pub) {
      if (server) continue;
      const ai = aiKeyName(name);
      const viaValue = !ai ? ctx.aiValueNames.get(name) : null;
      if (!ai && !viaValue) continue;
      const provider = ai ? ai.provider : viaValue.provider;
      const what = ai ? `${article(provider)} ${provider} key` : `${article(provider)} ${provider} key (its value in ${viaValue.file} is one)`;
      emit("BK002", t.s, t.e, {
        name,
        provider,
        short: `${name} read in client code ${where(pub) === "browser" ? "is shipped to the browser" : "is shipped in the app bundle"}`,
        message: `${name} is ${what}, and it is public because ${pub.how}: ${pub.framework} inlines its value into the ${where(pub) === "browser" ? "JavaScript sent to the browser" : "app bundle"}${client ? `, and this file is ${client}` : ""}. Anyone can read the key from the shipped code. ${SERVER_ADVICE}`,
        docUrl: pub.doc,
      });
    } else {
      if (!client) continue;
      const ai = aiKeyName(name);
      if (!ai) continue;
      const shortClient = client.replace(/ \(.*\)$/, "");
      emit("BK004", t.s, t.e, {
        name,
        provider: ai.provider,
        short: `server-only ${name} read in ${shortClient}`,
        message: `${name} is a server-only variable, but this file is ${client}. In the browser it is undefined, so the ${ai.provider} call can only work by leaking the key. Do not "fix" it with a public prefix (that ships the key to every visitor). ${SERVER_ADVICE}`,
        docUrl: frameworkDoc(proj),
      });
    }
  }

  // BK005 and nuxt / defineEnvVars BK001: build config.
  analyzeBuildConfig(T, rel, b, emit);

  // BK006: hardcoded keys in browser code.
  if (client) {
    for (let k = 0; k < T.length; k++) {
      const t = T[k];
      if (t.t !== "str" || typeof t.raw !== "string") continue;
      const nameCtx = (isP(T[k - 1], ":") || isP(T[k - 1], "=")) && keyName(T[k - 2]);
      const nameAi = nameCtx ? aiKeyName(nameCtx) : null;
      const googleCtx = geminiFile || !!(nameAi && /Google/.test(nameAi.provider));
      for (const hit of findKeysInString(t.raw, googleCtx)) {
        const start = t.rs + hit.index;
        emit("BK006", start, start + hit.length, {
          name: hit.provider,
          provider: hit.provider,
          short: `hardcoded ${hit.provider.replace(/ \(.*\)$/, "")} key ${mask(hit.shown)} in ${kind === "html" ? "an HTML page" : "browser code"}`,
          message: `${article(hit.provider)} ${hit.provider} API key (starts with ${hit.shown}, the rest is masked) is written into ${client}, which is shipped to the browser. Anyone can copy it from the page. Revoke it in the provider console, then ${SERVER_ADVICE.charAt(0).toLowerCase()}${SERVER_ADVICE.slice(1)}`,
          docUrl: hit.id === "google" ? data.DOCS.googleGenai : data.DOCS.keySafety,
        });
      }
    }
  }
}

const USER_KEY_RE = /user|byok|input|entered|provided|custom|own|form|setting|typed|pasted/i;

/** SDK clients with dangerouslyAllowBrowser: true, and the Anthropic direct-browser header. */
function findBrowserFlags(T) {
  const out = [];
  const importsOf = new Set(T.filter((t) => t.t === "str" && !t.tpl && data.BROWSER_FLAG_SDKS[t.v]).map((t) => t.v));
  for (let k = 0; k < T.length; k++) {
    const t = T[k];
    const kn = keyName(t);
    if (kn !== "dangerouslyAllowBrowser" && kn !== "anthropic-dangerous-direct-browser-access") continue;
    if (!isP(T[k + 1], ":") || !(isP(T[k - 1], "{") || isP(T[k - 1], ","))) continue;
    const v = T[k + 2];
    const isTrue = (isId(v, "true") || (v && v.t === "str" && v.v === "true") || (isP(v, "!") && T[k + 3] && T[k + 3].v === "0")) && (isP(T[k + (isP(v, "!") ? 4 : 3)], ",") || isP(T[k + (isP(v, "!") ? 4 : 3)], "}"));
    if (!isTrue) continue;
    const open = enclosingOpen(T, k, "{");
    const entries = open >= 0 ? objectEntries(T, open) : [];
    const header = kn !== "dangerouslyAllowBrowser";
    // Constructor: new X({ ... }) / new pkg.X({ ... })
    let ctor = null;
    if (open > 1 && isP(T[open - 1], "(") && isId(T[open - 2])) {
      let j = open - 2;
      const chain = [T[j].v];
      while (isP(T[j - 1], ".") && isId(T[j - 2])) {
        j -= 2;
        chain.unshift(T[j].v);
      }
      if (isId(T[j - 1], "new")) ctor = chain.join(".");
    }
    let sdk = null;
    const last = ctor ? ctor.split(".").pop() : null;
    for (const [pkg, info] of Object.entries(data.BROWSER_FLAG_SDKS)) if (last && info.ctor.includes(last)) sdk = info;
    if (!sdk && header) sdk = data.BROWSER_FLAG_SDKS["@anthropic-ai/sdk"];
    if (!sdk) for (const pkg of importsOf) sdk = sdk || data.BROWSER_FLAG_SDKS[pkg];
    const provider = sdk ? sdk.provider : "AI provider";
    const keyEntry = entries.find((e) => (header ? e.key.toLowerCase() === "x-api-key" : e.key === "apiKey" || e.key === "api_key"));
    let byok = false;
    let evidence = "";
    if (keyEntry && keyEntry.to > keyEntry.from) {
      const vt = T.slice(keyEntry.from, keyEntry.to);
      const literal = vt.some((x) => x.t === "str" && findKeysInString(x.raw || "", true).length);
      const fromEnv = vt.some((x, i) => (isId(x, "process") && isId(vt[i + 2], "env")) || (isId(x, "import") && isId(vt[i + 2], "meta")));
      if (!literal && !fromEnv) {
        for (let i = 0; i < vt.length; i++) {
          const x = vt[i];
          if (isId(x, "localStorage") || isId(x, "sessionStorage")) evidence = x.v;
          else if (isId(x, "prompt") && isP(vt[i + 1], "(")) evidence = "prompt()";
          else if (isId(x, "value") && isP(vt[i - 1], ".")) evidence = ".value of an input";
          else if (isId(x) && USER_KEY_RE.test(x.v)) evidence = x.v;
          if (evidence) break;
        }
        byok = !!evidence;
      }
    }
    const label = header ? "anthropic-dangerous-direct-browser-access" : `${ctor || "client"}({ dangerouslyAllowBrowser: true })`;
    const short = header
      ? `anthropic-dangerous-direct-browser-access header calls Claude from the browser${byok ? " with a user key" : ""}`
      : `${ctor ? "new " + ctor : "SDK client"}({ dangerouslyAllowBrowser: true }) ${byok ? "with a user-supplied key" : "exposes the API key"}`;
    const base = header
      ? `The anthropic-dangerous-direct-browser-access header lets the browser call the Anthropic API directly, so the x-api-key sent with it is visible to anyone using the page.`
      : `${ctor ? "new " + ctor : "This SDK client"}({ dangerouslyAllowBrowser: true }) runs the ${provider} SDK in the browser. The SDK disables browser use by default "to avoid exposing your secret API credentials": any visitor can read the key from the page and spend on it.`;
    const tail = byok
      ? ` The key seems to come from the user (${evidence}), the one case where this can be acceptable: make sure it is never your own key and is not stored longer than needed.`
      : ` ${SERVER_ADVICE}`;
    out.push({ idx: k, label, short, message: base + tail, provider, byok, doc: sdk ? sdk.doc : data.DOCS.openaiSdk });
  }
  return out;
}

function analyzeBuildConfig(T, rel, b, emit) {
  const isConfig = /\.config\.[cm]?[jt]s$/.test(b);
  const isNext = /^next\.config\./.test(b);
  const isNuxt = /^nuxt\.config\./.test(b);
  const loadEnvIds = new Set();
  for (let k = 0; k < T.length; k++) {
    if (isId(T[k]) && isP(T[k + 1], "=") && isId(T[k + 2], "loadEnv") && isP(T[k + 3], "(")) loadEnvIds.add(T[k].v);
  }
  const inline = (entries, how, doc) => {
    for (const e of entries) {
      const keyTok = T[e.keyIdx];
      const target = e.key;
      const name = target.replace(/^(?:process\.env\.|import\.meta\.env\.)/, "");
      const vt = T.slice(e.from, e.to);
      const wholeEnv = (target === "process.env" || target === "import.meta.env") &&
        (vt.some((x, i) => isId(x, "process") && isP(vt[i + 1], ".") && isId(vt[i + 2], "env") && !isP(vt[i + 3], ".") && !isP(vt[i + 3], "[")) || vt.some((x) => isId(x) && loadEnvIds.has(x.v) && !isP(T[T.indexOf(x) + 1], ".")));
      if (wholeEnv) {
        emit("BK005", keyTok.s, keyTok.e, {
          name: target,
          provider: "AI provider",
          short: `the whole ${target} inlined into the bundle by ${how}`,
          message: `${how} replaces ${target} with every environment variable at build time, so all of them, including any OpenAI, Anthropic or other AI provider key, end up in the JavaScript sent to the browser. Define only the public values you need. ${SERVER_ADVICE}`,
          docUrl: doc,
        });
        continue;
      }
      const ai = aiKeyName(name);
      const refs = aiRefsIn(T, e.from, e.to);
      const lit = vt.find((x) => x.t === "str" && findKeysInString(x.raw || "", false).length);
      if (!ai && !refs.length && !lit) continue;
      const provider = ai ? ai.provider : refs.length ? aiKeyName(refs[0].name).provider : findKeysInString(lit.raw, false)[0].provider;
      const from = !ai && refs.length ? ` (it takes ${refs[0].name})` : lit ? " (a hardcoded key, masked)" : "";
      emit("BK005", keyTok.s, keyTok.e, {
        name,
        provider,
        short: `${name} inlined into the bundle by ${how}`,
        message: `${how} replaces ${target}${from} with its value at build time, so the ${provider} key ends up in the JavaScript sent to the browser. Remove it from ${how}. ${SERVER_ADVICE}`,
        docUrl: doc,
      });
    }
  };
  for (let k = 0; k < T.length; k++) {
    const t = T[k];
    if (isConfig && isKeyAt(T, k, "define") && isP(T[k + 2], "{")) inline(objectEntries(T, k + 2), "vite define", data.DOCS.viteDefine);
    else if (isConfig && isKeyAt(T, k, "envPrefix")) {
      const v = T[k + 2];
      const list = [];
      if (v && v.t === "str") list.push(k + 2);
      else if (isP(v, "[")) {
        for (let j = k + 3; j < T.length && !isP(T[j], "]"); j++) if (T[j].t === "str") list.push(j);
      }
      for (const j of list) {
        const p = T[j].v;
        const ai = aiKeyName(p + "KEY") && p.length > 0 && !/^(?:VITE|PUBLIC|APP)_?$/i.test(p);
        if (!ai) continue;
        emit("BK005", T[j].s, T[j].e, {
          name: p,
          provider: aiKeyName(p + "KEY").provider,
          short: `envPrefix "${p}" exposes ${p}* variables to the browser`,
          message: `Vite exposes every variable that starts with an envPrefix entry on import.meta.env in client code. "${p}" matches AI provider keys such as ${p}API_KEY, so they would be bundled into the browser. Keep envPrefix to names that are safe to publish. ${SERVER_ADVICE}`,
          docUrl: data.DOCS.viteEnvPrefix,
        });
      }
    } else if (isId(t, "DefinePlugin") && isP(T[k + 1], "(") && isP(T[k + 2], "{")) inline(objectEntries(T, k + 2), "webpack DefinePlugin", data.DOCS.definePlugin);
    else if (isId(t, "EnvironmentPlugin") && isP(T[k + 1], "(")) {
      const names = [];
      const a = T[k + 2];
      if (a && a.t === "str") names.push(k + 2);
      else if (isP(a, "[")) {
        for (let j = k + 3; j < T.length && !isP(T[j], "]"); j++) if (T[j].t === "str") names.push(j);
      } else if (isP(a, "{")) {
        for (const e of objectEntries(T, k + 2)) names.push(e.keyIdx);
      }
      for (const j of names) {
        const ai = aiKeyName(T[j].v);
        if (!ai) continue;
        emit("BK005", T[j].s, T[j].e, {
          name: T[j].v,
          provider: ai.provider,
          short: `${T[j].v} inlined into the bundle by webpack EnvironmentPlugin`,
          message: `webpack EnvironmentPlugin replaces process.env.${T[j].v} with its value at build time, so the ${ai.provider} key ends up in the JavaScript sent to the browser. Remove it from EnvironmentPlugin. ${SERVER_ADVICE}`,
          docUrl: data.DOCS.environmentPlugin,
        });
      }
    } else if (isNext && isKeyAt(T, k, "env") && isP(T[k + 2], "{")) inline(objectEntries(T, k + 2), "next.config env", data.DOCS.nextConfigEnv);
    else if (isNext && isKeyAt(T, k, "publicRuntimeConfig") && isP(T[k + 2], "{")) inline(objectEntries(T, k + 2), "next.config publicRuntimeConfig", data.DOCS.next);
    else if (isNuxt && isKeyAt(T, k, "runtimeConfig") && isP(T[k + 2], "{")) {
      const pub = objectEntries(T, k + 2).find((e) => e.key === "public" && isP(T[e.from], "{"));
      if (!pub) continue;
      for (const e of objectEntries(T, pub.from)) {
        const ai = aiKeyName(e.key);
        if (!ai) continue;
        const kt = T[e.keyIdx];
        emit("BK001", kt.s, kt.e, {
          name: e.key,
          provider: ai.provider,
          short: `runtimeConfig.public.${e.key} in ${b} is sent to the browser`,
          message: `runtimeConfig.public.${e.key} (set by NUXT_PUBLIC_${toUpperSnake(e.key)}) is sent to the browser with every page: Nuxt exposes runtimeConfig.public to client code. The name says it is ${article(ai.provider)} ${ai.provider} key. Move it to the private top level of runtimeConfig and call ${ai.provider} from a server/api route.`,
          docUrl: data.DOCS.nuxt,
        });
      }
    } else if (isId(t, "defineEnvVars") && isP(T[k + 1], "(") && isP(T[k + 2], "{")) {
      for (const e of objectEntries(T, k + 2)) {
        if (!isP(T[e.from], "{")) continue;
        const isPublic = objectEntries(T, e.from).some((x) => x.key === "public" && isId(T[x.from], "true"));
        const ai = isPublic && aiKeyName(e.key);
        if (!ai) continue;
        const kt = T[e.keyIdx];
        emit("BK001", kt.s, kt.e, {
          name: e.key,
          provider: ai.provider,
          short: `${e.key} declared public in ${b} is sent to the browser`,
          message: `${e.key} is declared with public: true in defineEnvVars, so SvelteKit makes it importable from $app/env/public and it can end up in browser code. The name says it is ${article(ai.provider)} ${ai.provider} key. Drop public: true and import it from $app/env/private in server code only.`,
          docUrl: data.DOCS.sveltekitExplicit,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Excludes: glob matcher (hardened, no RegExp)
// ---------------------------------------------------------------------------------------------

/**
 * Compile a glob into a matcher { source, test(path) }, or null when the pattern is refused.
 * No RegExp is built: matching is a memoised walk over (pattern token, path index), so its cost is
 * bounded by pattern length x path length whatever the pattern ("*a*a*a*b" cannot backtrack).
 * Repeated "**\/" and runs of "*" are collapsed first; patterns over 300 characters or with more
 * than 4 "**" are refused. Inside [...] a backslash escapes the next character, so "\\", "[" and "]"
 * are always literal there.
 */
function globToRegExp(glob) {
  const g = String(glob).replace(/(?:\*\*\/)+/g, "**/").replace(/\*{3,}/g, "**");
  if (g.length > 300 || (g.match(/\*\*/g) || []).length > 4) return null;
  const alts = expandBraces(g, 0);
  if (!alts) return null;
  const programs = [];
  for (const a of alts) {
    const p = globTokens(a);
    if (!p) return null;
    programs.push(p);
  }
  return {
    source: g,
    test(path) {
      const s = String(path);
      if (s.length > 4096) return false;
      return programs.some((p) => globMatch(p, s));
    },
  };
}

/** Expand {a,b} groups (nested allowed), at most 64 alternatives; null when that is exceeded. */
function expandBraces(g, depth) {
  if (depth > 8) return null;
  let open = -1;
  let level = 0;
  let close = -1;
  for (let i = 0; i < g.length; i++) {
    if (g[i] === "\\") {
      i++;
      continue;
    }
    if (g[i] === "{") {
      if (level === 0) open = i;
      level++;
    } else if (g[i] === "}" && level > 0) {
      level--;
      if (level === 0) {
        close = i;
        break;
      }
    }
  }
  if (open < 0 || close < 0) return [g];
  const parts = [];
  let cur = "";
  level = 0;
  for (let i = open + 1; i < close; i++) {
    const c = g[i];
    if (c === "{") level++;
    if (c === "}") level--;
    if (c === "," && level === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const out = [];
  for (const part of parts) {
    const sub = expandBraces(g.slice(0, open) + part + g.slice(close + 1), depth + 1);
    if (!sub) return null;
    out.push(...sub);
    if (out.length > 64) return null;
  }
  return out;
}

function globTokens(g) {
  const toks = [];
  for (let i = 0; i < g.length; ) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        toks.push({ t: "dirs" });
        i += 3;
      } else {
        toks.push({ t: "any" });
        i += 2;
      }
      continue;
    }
    if (c === "*") {
      toks.push({ t: "star" });
      i++;
      continue;
    }
    if (c === "?") {
      toks.push({ t: "one" });
      i++;
      continue;
    }
    if (c === "[") {
      const cls = parseClass(g, i);
      if (cls) {
        toks.push(cls.tok);
        i = cls.next;
        continue;
      }
    }
    if (c === "\\" && i + 1 < g.length) {
      toks.push({ t: "lit", c: g[i + 1] });
      i += 2;
      continue;
    }
    toks.push({ t: "lit", c });
    i++;
  }
  return toks;
}

/** [...] / [!...] / [^...] with ranges; a backslash escapes the next character. */
function parseClass(g, start) {
  let i = start + 1;
  let neg = false;
  if (g[i] === "!" || g[i] === "^") {
    neg = true;
    i++;
  }
  const items = [];
  let first = true;
  while (i < g.length) {
    let c = g[i];
    if (c === "]" && !first) return { tok: { t: "cls", neg, items }, next: i + 1 };
    first = false;
    if (c === "\\" && i + 1 < g.length) c = g[++i];
    let hi = c;
    if (g[i + 1] === "-" && i + 2 < g.length && g[i + 2] !== "]") {
      hi = g[i + 2] === "\\" && i + 3 < g.length ? g[i + 3] : g[i + 2];
      i += g[i + 2] === "\\" ? 4 : 3;
    } else i++;
    if (hi < c) return null;
    items.push([c, hi]);
  }
  return null;
}

function globMatch(toks, s) {
  const P = toks.length;
  const S = s.length;
  const memo = new Uint8Array((P + 1) * (S + 1));
  const m = (pi, si) => {
    const key = pi * (S + 1) + si;
    if (memo[key]) return memo[key] === 1;
    let r;
    if (pi === P) r = si === S;
    else {
      const t = toks[pi];
      const ch = s[si];
      if (t.t === "lit") r = si < S && ch === t.c && m(pi + 1, si + 1);
      else if (t.t === "one") r = si < S && ch !== "/" && m(pi + 1, si + 1);
      else if (t.t === "cls") r = si < S && ch !== "/" && t.items.some(([a, b]) => ch >= a && ch <= b) !== t.neg && m(pi + 1, si + 1);
      else if (t.t === "star") r = m(pi + 1, si) || (si < S && ch !== "/" && m(pi, si + 1));
      else if (t.t === "any") r = m(pi + 1, si) || (si < S && m(pi, si + 1));
      else {
        // "**/": zero or more whole directories.
        r = m(pi + 1, si);
        if (!r) {
          const j = s.indexOf("/", si);
          r = j >= 0 && m(pi, j + 1);
        }
      }
    }
    memo[key] = r ? 1 : 2;
    return r;
  };
  return m(0, 0);
}

function makeExcluder(globs) {
  const res = (Array.isArray(globs) ? globs : []).filter((g) => typeof g === "string" && g.trim()).slice(0, 200).map((g) => ({ g: g.trim(), re: globToRegExp(g.trim()) })).filter((x) => x.re);
  return (rel) => {
    const p = String(rel).replace(/\\/g, "/");
    const base = p.split("/").pop();
    return res.some((x) => x.re.test(p) || (!x.g.includes("/") && x.re.test(base)));
  };
}

module.exports = {
  RULES,
  RULE_IDS,
  SEVERITIES,
  SOURCE_DATE: data.SOURCE_DATE,
  resolveSeverities,
  findingSeverity,
  compileIgnore,
  sanitizePrefixes,
  toUpperSnake,
  aiKeyName,
  aiKeyValue,
  findKeysInString,
  mask,
  kindFromPath,
  isContextFile,
  frameworksFromPackage,
  extractConfigPrefixes,
  makeContext,
  projectFor,
  noteValueFindings,
  lex,
  scriptOnly,
  analyze,
  globToRegExp,
  makeExcluder,
};
