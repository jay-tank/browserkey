# Changelog

## 0.1.0 - Initial release

- Six rules for AI provider API keys that reach the browser: BK001 public-prefixed variable holding an
  AI key (`.env*`, CI workflows, Dockerfile, compose, `netlify.toml`, Nuxt `runtimeConfig.public`,
  SvelteKit `defineEnvVars`), BK002 public AI key read in client code, BK003 SDK client with
  `dangerouslyAllowBrowser: true` (information when the key comes from the user), BK004 server-only
  key read in a client-side file, BK005 key inlined by Vite `define`, webpack `DefinePlugin` /
  `EnvironmentPlugin`, `next.config` `env` / `publicRuntimeConfig` or `envPrefix`, BK006 hardcoded key
  in frontend code. Each rule has a configurable severity or can be turned off.
- Next.js, Vite, Create React App, SvelteKit, Astro, Nuxt, Gatsby and Expo, detected per
  `package.json`, so monorepos work.
- Keys recognised by name, by documented prefix (OpenAI, Anthropic, OpenRouter, Groq, xAI, Perplexity,
  Hugging Face, Replicate, Gemini with context) and by reference to an AI secret. Values always masked.
- Quick Fixes: rename a public `.env` variable to its server-only name (name only, never the value),
  and open the framework or SDK documentation for any finding.
- Browser key checks view in its own activity bar container, grouped by file, with rows naming the
  exact variable or client, inline Quick Fix and docs buttons and a findings badge. Status bar `BrowserKey: N`.
- No network, no telemetry, no child processes. Works in untrusted workspaces (exclude and ignore
  settings then come only from user settings).
