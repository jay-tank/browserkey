"use strict";

// Shared fixtures for the unit and in-editor tests. Fake keys are assembled at runtime so no
// key-shaped literal is ever stored in this repository.

function body(n, alphabet) {
  const a = alphabet || "AbCdEfGhJkLmNpQrStUvWz23456789";
  let s = "";
  for (let i = 0; i < n; i++) s += a[(i * 7 + 3) % a.length];
  return s;
}

const KEYS = {
  openai: "sk-" + "proj-" + body(48),
  openaiLegacy: "sk-" + body(48, "AbCdEfGhJkLmNpQrStUvWz23456789"),
  anthropic: "sk-" + "ant-" + "api03-" + body(60),
  google: "AI" + "za" + body(35),
  groq: "gs" + "k_" + body(52),
  openrouter: "sk-" + "or-v1-" + body(64, "0123456789abcdef"),
  xai: "xa" + "i-" + body(80),
  hf: "h" + "f_" + body(34, "AbCdEfGhJkLmNpQrStUvWz"),
};

const PKG = {
  next: JSON.stringify({ name: "web", dependencies: { next: "15.5.0", react: "19.0.0", openai: "5.0.0" } }),
  vite: JSON.stringify({ name: "spa", dependencies: { react: "19.0.0", "@anthropic-ai/sdk": "0.60.0" }, devDependencies: { vite: "7.0.0" } }),
  sveltekit: JSON.stringify({ name: "kit", devDependencies: { "@sveltejs/kit": "2.62.0", vite: "7.0.0" } }),
  nuxt: JSON.stringify({ name: "nuxt-app", dependencies: { nuxt: "4.1.0" } }),
  expo: JSON.stringify({ name: "mobile", dependencies: { expo: "54.0.0" } }),
  plain: JSON.stringify({ name: "api", dependencies: { express: "5.0.0", openai: "5.0.0" } }),
};

/** A multi-project workspace: rel path -> text. EXPECT lists [rel, rule, name or null, line]. */
function workspace() {
  const K = KEYS;
  return {
    "apps/web/package.json": PKG.next,
    "apps/web/.env.local": [
      "# AI keys",
      "NEXT_PUBLIC_OPENAI_API_KEY=" + K.openai,
      "NEXT_PUBLIC_ASSIST=" + K.anthropic,
      "NEXT_PUBLIC_OPENAI_MODEL=gpt-5",
      "OPENAI_API_KEY=" + K.openai,
      "NEXT_PUBLIC_SITE_URL=https://example.com",
      "",
    ].join("\n"),
    "apps/web/app/chat/page.tsx": [
      '"use client";',
      'import OpenAI from "openai";',
      "const client = new OpenAI({",
      "  apiKey: process.env.NEXT_PUBLIC_OPENAI_API_KEY,",
      "  dangerouslyAllowBrowser: true,",
      "});",
      "const helper = process.env.NEXT_PUBLIC_ASSIST;",
      "const server = process.env.ANTHROPIC_API_KEY;",
      "export default function Page() { return <p>Don't do this</p>; }",
      "",
    ].join("\n"),
    "apps/web/app/api/chat/route.ts": [
      'import OpenAI from "openai";',
      "const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });",
      "export async function POST() { return Response.json({}); }",
      "",
    ].join("\n"),
    "apps/web/next.config.mjs": [
      "export default {",
      "  env: {",
      "    OPENAI_API_KEY: process.env.OPENAI_API_KEY,",
      "    SITE_NAME: 'demo',",
      "  },",
      "};",
      "",
    ].join("\n"),
    "apps/spa/package.json": PKG.vite,
    "apps/spa/.env": ["VITE_ANTHROPIC_API_KEY=", "VITE_APP_TITLE=Demo", ""].join("\n"),
    "apps/spa/vite.config.ts": [
      'import { defineConfig, loadEnv } from "vite";',
      "export default defineConfig(({ mode }) => {",
      '  const env = loadEnv(mode, process.cwd(), "");',
      "  return {",
      "    define: {",
      '      "process.env.GEMINI_API_KEY": JSON.stringify(env.GEMINI_API_KEY),',
      '      __APP_VERSION__: JSON.stringify("1.0.0"),',
      "    },",
      "  };",
      "});",
      "",
    ].join("\n"),
    "apps/spa/src/llm.ts": [
      'import Anthropic from "@anthropic-ai/sdk";',
      "export const claude = new Anthropic({",
      "  apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY,",
      "  dangerouslyAllowBrowser: true,",
      "});",
      "const g = import.meta.env.GEMINI_API_KEY;",
      "",
    ].join("\n"),
    "apps/spa/src/byok.ts": [
      'import OpenAI from "openai";',
      "export function makeClient(userApiKey: string) {",
      "  return new OpenAI({ apiKey: userApiKey, dangerouslyAllowBrowser: true });",
      "}",
      "",
    ].join("\n"),
    "apps/spa/src/keys.ts": ['export const GROQ = "' + K.groq + '";', "export const title = `sk-not-a-key`;", ""].join("\n"),
    "apps/kit/package.json": PKG.sveltekit,
    "apps/kit/src/routes/+page.svelte": [
      "<script>",
      "  import { PUBLIC_OPENAI_API_KEY } from '$env/static/public';",
      "  import { OPENAI_ORG_ID } from '$env/static/public';",
      "</script>",
      "<p>{PUBLIC_OPENAI_API_KEY}</p>",
      "",
    ].join("\n"),
    "apps/kit/src/routes/+page.server.ts": ["import { OPENAI_API_KEY } from '$env/static/private';", "export const load = () => ({});", ""].join("\n"),
    "apps/nuxt/package.json": PKG.nuxt,
    "apps/nuxt/nuxt.config.ts": [
      "export default defineNuxtConfig({",
      "  runtimeConfig: {",
      "    openaiApiKey: '',",
      "    public: {",
      "      mistralApiKey: '',",
      "      siteUrl: '',",
      "    },",
      "  },",
      "});",
      "",
    ].join("\n"),
    "apps/mobile/package.json": PKG.expo,
    "apps/mobile/app/index.tsx": ["const key = process.env.EXPO_PUBLIC_GROQ_API_KEY;", ""].join("\n"),
    "apps/api/package.json": PKG.plain,
    "apps/api/src/index.ts": ['import OpenAI from "openai";', "const c = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });", ""].join("\n"),
    ".github/workflows/deploy.yml": [
      "name: deploy",
      "on: push",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    env:",
      "      NEXT_PUBLIC_API_TOKEN: ${{ secrets.OPENAI_API_KEY }}",
      "      NEXT_PUBLIC_ANALYTICS_ID: ${{ secrets.ANALYTICS_ID }}",
      "    steps:",
      "      - run: npm run build",
      "",
    ].join("\n"),
    "apps/web/Dockerfile": [
      "FROM node:22",
      "# ARG NEXT_PUBLIC_COMMENTED_OPENAI_KEY",
      "ARG NEXT_PUBLIC_CLAUDE_KEY",
      "ENV NEXT_PUBLIC_CLAUDE_KEY=$NEXT_PUBLIC_CLAUDE_KEY",
      "RUN npm run build",
      "",
    ].join("\n"),
    "public/index.html": ["<html><body><script>", 'const k = "' + K.openrouter + '";', "</script></body></html>", ""].join("\n"),
  };
}

const EXPECT = [
  ["apps/web/.env.local", "BK001", "NEXT_PUBLIC_OPENAI_API_KEY", 1],
  ["apps/web/.env.local", "BK001", "NEXT_PUBLIC_ASSIST", 2],
  ["apps/web/app/chat/page.tsx", "BK002", "NEXT_PUBLIC_OPENAI_API_KEY", 3],
  ["apps/web/app/chat/page.tsx", "BK003", null, 4],
  ["apps/web/app/chat/page.tsx", "BK002", "NEXT_PUBLIC_ASSIST", 6],
  ["apps/web/app/chat/page.tsx", "BK004", "ANTHROPIC_API_KEY", 7],
  ["apps/web/next.config.mjs", "BK005", "OPENAI_API_KEY", 2],
  ["apps/spa/.env", "BK001", "VITE_ANTHROPIC_API_KEY", 0],
  ["apps/spa/vite.config.ts", "BK005", "GEMINI_API_KEY", 5],
  ["apps/spa/src/llm.ts", "BK002", "VITE_ANTHROPIC_API_KEY", 2],
  ["apps/spa/src/llm.ts", "BK003", null, 3],
  ["apps/spa/src/llm.ts", "BK004", "GEMINI_API_KEY", 5],
  ["apps/spa/src/byok.ts", "BK003", null, 2],
  ["apps/spa/src/keys.ts", "BK006", null, 0],
  ["apps/kit/src/routes/+page.svelte", "BK002", "PUBLIC_OPENAI_API_KEY", 1],
  ["apps/nuxt/nuxt.config.ts", "BK001", "mistralApiKey", 4],
  ["apps/mobile/app/index.tsx", "BK002", "EXPO_PUBLIC_GROQ_API_KEY", 0],
  [".github/workflows/deploy.yml", "BK001", "NEXT_PUBLIC_API_TOKEN", 6],
  ["apps/web/Dockerfile", "BK001", "NEXT_PUBLIC_CLAUDE_KEY", 2],
  ["public/index.html", "BK006", null, 1],
];


/** Files the in-editor test adds (hostile names, excluded folders, Quick Fix and live-edit targets). */
function extraFiles() {
  const K = KEYS;
  return {
    "weird dir/na\u00efve file (1).tsx": '"use client";\nconst k = process.env.OPENAI_API_KEY;\n',
    "gen/.env.production": "VITE_OPENAI_KEY=1\n",
    "fix/.env": "NEXT_PUBLIC_GROQ_API_KEY=abc\n",
    "clean/firebase.tsx": '"use client";\nconst firebase = { apiKey: "' + K.google + '" };\nconst m = process.env.NEXT_PUBLIC_OPENAI_MODEL;\nconst c = new OpenAI({ dangerouslyAllowBrowser: false });\n',
    "clean/.env.example": "NEXT_PUBLIC_FIREBASE_API_KEY=" + K.google + "\nOPENAI_API_KEY=\n",
    "live/live.tsx": '"use client";\nexport const x = 1;\n',
    "node_modules/pkg/.env": "NEXT_PUBLIC_OPENAI_API_KEY=1\n",
    "node_modules/pkg/index.tsx": '"use client";\nconst k = process.env.NEXT_PUBLIC_OPENAI_API_KEY;\n',
    "dist/app.js": '"use client";\nconst k = "' + K.anthropic + '";\n',
  };
}
const EXTRA_EXPECT = [
  ["weird dir/na\u00efve file (1).tsx", "BK004", "OPENAI_API_KEY", 1],
  ["gen/.env.production", "BK001", "VITE_OPENAI_KEY", 0],
  ["fix/.env", "BK001", "NEXT_PUBLIC_GROQ_API_KEY", 0],
];

module.exports = { KEYS, PKG, body, workspace, EXPECT, extraFiles, EXTRA_EXPECT };
