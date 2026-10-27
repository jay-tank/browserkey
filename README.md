# BrowserKey: AI API Key Exposure in Frontend Code Checker

You add a chat box to your app. The OpenAI call fails in the browser with `apiKey is undefined`,
so you rename `OPENAI_API_KEY` to `NEXT_PUBLIC_OPENAI_API_KEY`, or add
`dangerouslyAllowBrowser: true`, and it works. It also ships your key to every visitor:

```ts
"use client";
const client = new OpenAI({
  apiKey: process.env.NEXT_PUBLIC_OPENAI_API_KEY, // inlined into the JavaScript bundle
  dangerouslyAllowBrowser: true,                 // the SDK's own opt-out of its safety check
});
```

Anyone can open DevTools, copy the key and spend on your account. BrowserKey finds the ways an
OpenAI, Anthropic, Gemini, Groq, Mistral, Cohere, OpenRouter, xAI, DeepSeek, Perplexity, Hugging Face
or other AI provider key reaches the browser, while you write the code.

It is not a general secret scanner. It only reports **AI provider keys** that reach **client code**:
framework public prefixes, client components, SDK browser flags and bundler inlining.

## What you see

- **Browser key checks** in its own activity bar container (key over a browser window), grouped by
  file. Each row names the exact thing, for example
  `NEXT_PUBLIC_OPENAI_API_KEY in .env.local is bundled into the browser`,
  `new OpenAI({ dangerouslyAllowBrowser: true }) exposes the API key` or
  `server-only ANTHROPIC_API_KEY read in a "use client" component`. The row description is the rule
  and line, the tooltip has the full explanation, and clicking a row opens the file at that line.
- Inline row buttons: **Apply Quick Fix** (where one exists) and **Open docs** (the framework or SDK
  page that explains the rule). A badge on the activity bar icon shows the number of findings.
- Squiggles and Problems entries in `.env` files, CI workflows, Dockerfiles, compose files and
  JS/TS/JSX/TSX/Vue/Svelte/HTML files, plus `BrowserKey: N` in the status bar.
- **Secret values are never shown.** A key found by its value is described by its documented prefix
  only, such as `sk-proj-****` or `sk-ant-api03-****`.

## Rules

| Rule | Default | What it reports |
| :--- | :--- | :--- |
| BK001 | error | A public-prefixed variable (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `EXPO_PUBLIC_`, `NUXT_PUBLIC_`, `GATSBY_`, `PUBLIC_` in SvelteKit/Astro) holds an AI key, in `.env*` files, GitHub Actions / GitLab CI and other CI files, Dockerfile `ARG`/`ENV`, compose files and `netlify.toml`. Also `runtimeConfig.public` keys in `nuxt.config` and `public: true` in SvelteKit `defineEnvVars`. |
| BK002 | error | A public AI key variable is read in client code: `process.env.NEXT_PUBLIC_*`, `import.meta.env.VITE_*`, `$env/static/public`, `$env/dynamic/public`, `$app/env/public`, `useRuntimeConfig().public.*`. |
| BK003 | error | An SDK client created with `dangerouslyAllowBrowser: true` (OpenAI, Anthropic and Groq JS SDKs), or the `anthropic-dangerous-direct-browser-access` header. **Information** when the `apiKey` seems to come from the user (see below). |
| BK004 | warning | A server-only AI key (`process.env.OPENAI_API_KEY`, `$env/static/private`) is read in a client-side file, where it is undefined and the usual "fix" leaks it. |
| BK005 | error | An AI key is inlined into the bundle by Vite `define`, webpack `DefinePlugin` / `EnvironmentPlugin`, `next.config` `env` or `publicRuntimeConfig`, or an `envPrefix` entry that matches AI keys. Also `define: { "process.env": process.env }`, which inlines every variable. |
| BK006 | error | A hardcoded AI key literal in a client-side file or an HTML page. |

### How a key is recognised

- **By name**: a provider word (`OPENAI`, `ANTHROPIC`, `CLAUDE`, `GEMINI`, `GOOGLE_AI`, `MISTRAL`,
  `GROQ`, `COHERE` / `CO_API_KEY`, `OPENROUTER`, `XAI`, `DEEPSEEK`, `PERPLEXITY`, `HF`, and more) plus a
  credential word (`KEY`, `API_KEY`, `TOKEN`, `SECRET`). camelCase works (`openaiApiKey`). Names that
  end in `URL`, `MODEL`, `ID`, `ORG`, `VERSION` and similar are configuration, not keys.
- **By value**: documented key formats such as `sk-proj-`, `sk-ant-api03-`, `sk-or-v1-`, `gsk_`, `xai-`,
  `pplx-`, `hf_`, `r8_`. Placeholders (`sk-...`, `your-key-here`, `xxxx`) are ignored. Google `AIza`
  keys count only when the name or the file says Gemini, because Firebase and Maps browser keys use
  the same format and are meant to be public.
- **By reference**: `NEXT_PUBLIC_TOKEN: ${{ secrets.OPENAI_API_KEY }}` or `ENV VITE_K=$ANTHROPIC_API_KEY`.

### Which files are client-side

`"use client"` files, Vue and Svelte components, `*.client.*` files, SvelteKit `+page.ts` /
`+layout.ts` / `hooks.client`, `src/` of a Vite single-page app, Create React App and Gatsby, Expo app
code, HTML pages, and any file that creates an SDK client with `dangerouslyAllowBrowser: true`. The
framework comes from the nearest `package.json`, so monorepos work. Server files are never treated as
client code: `"use server"`, `*.server.*`, `+server.ts`, Expo `+api.ts`, Next.js `route.ts`,
`middleware`, `pages/api/` and `app/**/api/`, Gatsby `src/api/`, and `server/`, `functions/`,
`scripts/` folders.

### User-supplied keys (BK003)

Some apps let users paste their own key ("bring your own key"). When the `apiKey` value reads from
`localStorage`, `sessionStorage`, `prompt()`, an input's `.value` or a name such as `userApiKey`,
BK003 is reported as information instead of an error. This is a name-based heuristic: set
`browserKey.rules` `{ "BK003": "error" }` to always treat it as an error.

## Quick Fixes

- **Rename to OPENAI_API_KEY (server-only)** on a public-prefixed variable in a `.env` file. Only the
  name changes, never the value, and only when the server-only name is not already in that file.
  Then move the provider call to a server route.
- **Open docs** on every finding: the Next.js, Vite, SvelteKit, Nuxt, Expo, Create React App, Gatsby,
  webpack or SDK page that explains why the value reaches the browser.

BrowserKey never edits key values and never removes `dangerouslyAllowBrowser` for you: the right fix
is to move the call behind a server route, which it cannot write for you.

## Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `browserKey.enabled` | `true` | Turn the checks on or off. |
| `browserKey.rules` | `{}` | Severity per rule (`error`, `warning`, `information`, `hint`) or `off`. |
| `browserKey.extraPublicPrefixes` | `[]` | More prefixes your build exposes, e.g. `["STORYBOOK_"]`. A string-literal Vite `envPrefix` or SvelteKit `publicPrefix` is read from the config automatically. |
| `browserKey.ignoreNames` | `""` | Regular expression (max 200 characters) for variable names never reported, e.g. a key to your own proxy. |
| `browserKey.maxFiles` | `3000` | Maximum files scanned (open files are always checked). Files over 1 MB are skipped. |
| `browserKey.exclude` | build and dependency folders | Glob patterns never scanned. `node_modules`, `.git`, `dist`, `build` and `vendor` are always excluded. |

## Commands

- **BrowserKey: Rescan Workspace**
- **BrowserKey: Show Browser Key Checks**
- **BrowserKey: Open Settings**

## Privacy and safety

- No network, no telemetry, no child processes. Everything runs locally on the files in your workspace.
- Key values are never displayed, logged or stored: findings keep only the documented prefix.
- Files are read only inside the workspace (symlinks that point outside are skipped), up to 1 MB each.
- Works in untrusted workspaces. There, `browserKey.exclude` and `browserKey.ignoreNames` are taken
  only from your user settings, so a repository cannot hide its own findings. Glob patterns are matched
  without regular expressions and over-long or `**`-heavy patterns are refused.

## Limitations

- The analysis is lexical and per file. A server-only key read in a shared module that a client
  component imports is not followed across files.
- Next.js `pages/` components run on both server and client, so only `"use client"` files are treated
  as client code in Next.js projects (BK002 still reports public AI keys anywhere outside server files).
- Astro `.astro` files and Vue/Svelte template expressions are not analysed; `<script>` blocks are.
- `envPrefix` and `publicPrefix` are read only when written as string literals in the config file.
- Key formats change. Provider keys without a documented prefix (Mistral, Cohere) are recognised by
  the variable name only.

## References

- [Next.js: Bundling environment variables for the browser](https://nextjs.org/docs/app/guides/environment-variables)
- [Vite: Env variables and modes](https://vite.dev/guide/env-and-mode)
- [OpenAI Node SDK: Requirements (dangerouslyAllowBrowser)](https://github.com/openai/openai-node#requirements)

## License

MIT - included with the extension.
