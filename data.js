"use strict";

// Reference tables for BrowserKey. Every entry names its source; checked on SOURCE_DATE.

const SOURCE_DATE = "2026-10-24";

const DOCS = {
  next: "https://nextjs.org/docs/app/guides/environment-variables",
  nextConfigEnv: "https://nextjs.org/docs/app/api-reference/config/next-config-js/env",
  vite: "https://vite.dev/guide/env-and-mode",
  viteDefine: "https://vite.dev/config/shared-options#define",
  viteEnvPrefix: "https://vite.dev/config/shared-options#envprefix",
  cra: "https://create-react-app.dev/docs/adding-custom-environment-variables/",
  sveltekit: "https://svelte.dev/docs/kit/$env-static-public",
  sveltekitExplicit: "https://svelte.dev/docs/kit/environment-variables",
  astro: "https://docs.astro.build/en/guides/environment-variables/",
  expo: "https://docs.expo.dev/guides/environment-variables/",
  nuxt: "https://nuxt.com/docs/api/composables/use-runtime-config",
  gatsby: "https://www.gatsbyjs.com/docs/how-to/local-development/environment-variables/",
  definePlugin: "https://webpack.js.org/plugins/define-plugin/",
  environmentPlugin: "https://webpack.js.org/plugins/environment-plugin/",
  openaiSdk: "https://github.com/openai/openai-node#requirements",
  anthropicSdk: "https://github.com/anthropics/anthropic-sdk-typescript#requirements",
  groqSdk: "https://github.com/groq/groq-typescript#requirements",
  googleGenai: "https://github.com/googleapis/js-genai#browser",
  keySafety: "https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html",
};

/**
 * Variable name prefixes that frameworks inline into client code.
 * always: the prefix is distinctive enough to be checked in every project.
 * Otherwise it is only checked in projects whose package.json has one of `frameworks`.
 */
const PUBLIC_PREFIXES = [
  // Next.js: "prefix the variable with NEXT_PUBLIC_ ... It will be inlined into any JavaScript sent to the browser."
  { prefix: "NEXT_PUBLIC_", framework: "Next.js", always: true, where: "browser", doc: DOCS.next },
  // Vite: "Variables prefixed with VITE_ will be exposed in client-side source code after Vite bundling."
  { prefix: "VITE_", framework: "Vite", always: true, where: "browser", doc: DOCS.vite },
  // Create React App: only REACT_APP_ variables are embedded into the build.
  { prefix: "REACT_APP_", framework: "Create React App", always: true, where: "browser", doc: DOCS.cra },
  // Expo: "process.env.EXPO_PUBLIC_... will be replaced ... in your app bundle", "visible in plain-text in your compiled application".
  { prefix: "EXPO_PUBLIC_", framework: "Expo", always: true, where: "app bundle", doc: DOCS.expo },
  // Nuxt: NUXT_PUBLIC_* environment variables override runtimeConfig.public, which is sent to the client.
  { prefix: "NUXT_PUBLIC_", framework: "Nuxt", always: true, where: "browser", doc: DOCS.nuxt },
  // Gatsby: GATSBY_-prefixed variables are embedded in client-side JavaScript.
  { prefix: "GATSBY_", framework: "Gatsby", always: true, where: "browser", doc: DOCS.gatsby },
  // SvelteKit $env/static/public (config.kit.env.publicPrefix, default PUBLIC_) and Astro import.meta.env.PUBLIC_*.
  { prefix: "PUBLIC_", framework: "SvelteKit / Astro", always: false, frameworks: ["sveltekit", "astro"], where: "browser", doc: DOCS.sveltekit },
];

/**
 * Words in a variable name that identify an AI provider. Matched against whole "_"-separated
 * parts of the upper-snake name (camelCase is split first), or a part that starts with the word
 * followed by KEY/APIKEY/TOKEN/SECRET (OPENAIKEY).
 */
const PROVIDER_WORDS = {
  OPENAI: "OpenAI",
  AZUREOPENAI: "Azure OpenAI",
  CHATGPT: "OpenAI",
  GPT: "OpenAI",
  ANTHROPIC: "Anthropic",
  CLAUDE: "Anthropic",
  GEMINI: "Google Gemini",
  GENAI: "Google Gemini",
  GENERATIVEAI: "Google Gemini",
  VERTEX: "Google Vertex AI",
  MISTRAL: "Mistral",
  MISTRALAI: "Mistral",
  GROQ: "Groq",
  GROK: "xAI",
  XAI: "xAI",
  COHERE: "Cohere",
  OPENROUTER: "OpenRouter",
  DEEPSEEK: "DeepSeek",
  PERPLEXITY: "Perplexity",
  PPLX: "Perplexity",
  TOGETHER: "Together AI",
  TOGETHERAI: "Together AI",
  FIREWORKS: "Fireworks AI",
  REPLICATE: "Replicate",
  HUGGINGFACE: "Hugging Face",
  HF: "Hugging Face",
  CEREBRAS: "Cerebras",
  DEEPINFRA: "DeepInfra",
  AI21: "AI21",
  VOYAGE: "Voyage AI",
  ELEVENLABS: "ElevenLabs",
  LLM: "LLM provider",
  AI: "AI provider",
};

/** Two-part provider names: GOOGLE_AI, GOOGLE_GENAI, CO_API_KEY (Cohere's documented variable). */
const PROVIDER_PAIRS = [
  ["GOOGLE", "AI", "Google Gemini"],
  ["GOOGLE", "GENAI", "Google Gemini"],
  ["GOOGLE", "GENERATIVE", "Google Gemini"],
  ["GOOGLE", "GEMINI", "Google Gemini"],
  ["CO", "API", "Cohere"],
  ["TOGETHER", "AI", "Together AI"],
  ["HUGGING", "FACE", "Hugging Face"],
];

/** Name parts that make a variable a credential. */
const SECRET_WORDS = ["KEY", "APIKEY", "TOKEN", "SECRET", "ACCESSTOKEN", "AUTHTOKEN", "PAT"];

/** A name whose LAST part is one of these is configuration, not a credential (OPENAI_API_KEY_URL, OPENAI_KEY_ID). */
const NON_SECRET_SUFFIXES = ["URL", "URI", "ENDPOINT", "HOST", "BASE", "ID", "NAME", "MODEL", "ORG", "ORGANIZATION", "PROJECT", "VERSION", "REGION", "DEPLOYMENT", "ENABLED", "DISABLED", "PATH", "HEADER", "TYPE", "LENGTH", "COUNT", "LIMIT", "PREFIX", "FILE", "HASH", "EXPIRY", "EXPIRES", "TTL", "LABEL", "HINT"];

/**
 * Key formats. `re` is matched with identifier-character boundaries on both sides. `shown` is the
 * documented prefix shown in messages; nothing after it is ever displayed.
 * needsContext: the format is shared with keys that are meant to be public (Google AIza keys are
 * also Firebase / Maps browser keys), so it only counts when the variable name or the file says Gemini.
 */
const KEY_PATTERNS = [
  // gitleaks anthropic-api-key / anthropic-admin-api-key: sk-ant-api03-..., sk-ant-admin01-...
  { id: "anthropic", provider: "Anthropic", re: "sk-ant-(?:api|admin)\\d{2}-[A-Za-z0-9_-]{20,}", shown: (m) => m.slice(0, m.indexOf("-", 7) + 1), source: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml" },
  // trufflehog openrouter detector: sk-or-v1- + 64 hex
  { id: "openrouter", provider: "OpenRouter", re: "sk-or-v1-[0-9a-f]{32,}", shown: () => "sk-or-v1-", source: "https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/openrouter/openrouter.go" },
  // gitleaks openai-api-key: sk-proj-, sk-svcacct-, sk-admin-
  { id: "openai", provider: "OpenAI", re: "sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}", shown: (m) => m.slice(0, m.indexOf("-", 3) + 1), source: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml" },
  // gitleaks openai-api-key (legacy sk-...T3BlbkFJ...) and trufflehog deepseek (sk- + 32): OpenAI-style secret keys
  { id: "openai-style", provider: "OpenAI-style (OpenAI, DeepSeek or another OpenAI-compatible API)", re: "sk-[A-Za-z0-9]{32,}", shown: () => "sk-", source: "https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/deepseek/deepseek.go" },
  // trufflehog groq detector: gsk_ + 52
  { id: "groq", provider: "Groq", re: "gsk_[A-Za-z0-9]{40,}", shown: () => "gsk_", source: "https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/groq/groq.go" },
  // trufflehog xai detector: xai- + 80
  { id: "xai", provider: "xAI", re: "xai-[A-Za-z0-9_]{40,}", shown: () => "xai-", source: "https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/xai/xai.go" },
  // gitleaks perplexity-api-key: pplx- + 48
  { id: "perplexity", provider: "Perplexity", re: "pplx-[A-Za-z0-9]{40,}", shown: () => "pplx-", source: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml" },
  // gitleaks huggingface-access-token: hf_ + 34 letters
  { id: "huggingface", provider: "Hugging Face", re: "hf_[A-Za-z]{30,}", shown: () => "hf_", source: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml" },
  // trufflehog replicate detector: r8_ + 37
  { id: "replicate", provider: "Replicate", re: "r8_[A-Za-z0-9_-]{30,}", shown: () => "r8_", source: "https://github.com/trufflesecurity/trufflehog/blob/main/pkg/detectors/replicate/replicate.go" },
  // gitleaks gcp-api-key: AIza + 35. Also used by Firebase and Maps browser keys, hence needsContext.
  { id: "google", provider: "Google Gemini", re: "AIza[A-Za-z0-9_-]{35}", shown: () => "AIza", needsContext: true, source: "https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml" },
];

/** Values that are clearly placeholders, never reported by value. */
const PLACEHOLDER_RE = /x{6,}|X{6,}|\.\.\.|\*{3,}|your|example|placeholder|changeme|change_me|dummy|redacted|<|>|\{\{|0{12,}/i;

/** JS SDK packages whose client has a dangerouslyAllowBrowser option (README "Requirements" section). */
const BROWSER_FLAG_SDKS = {
  openai: { provider: "OpenAI", ctor: ["OpenAI", "AzureOpenAI"], doc: DOCS.openaiSdk },
  "@anthropic-ai/sdk": { provider: "Anthropic", ctor: ["Anthropic", "AnthropicBedrock", "AnthropicVertex"], doc: DOCS.anthropicSdk },
  "groq-sdk": { provider: "Groq", ctor: ["Groq"], doc: DOCS.groqSdk },
};

/** Packages whose import marks a file as using the Gemini API (gives Google AIza keys context). */
const GEMINI_PACKAGES = ["@google/genai", "@google/generative-ai", "@ai-sdk/google", "@langchain/google-genai"];

/**
 * package.json dependency -> framework id. "vite-ssr" marks a Vite-based framework with server
 * code, so a plain Vite project without any of them is treated as a single-page app.
 */
const FRAMEWORK_DEPS = {
  next: "next",
  "react-scripts": "cra",
  vite: "vite",
  "@sveltejs/kit": "sveltekit",
  astro: "astro",
  nuxt: "nuxt",
  nuxt3: "nuxt",
  gatsby: "gatsby",
  expo: "expo",
};
const VITE_SSR_DEPS = ["nuxt", "nuxt3", "@sveltejs/kit", "astro", "@remix-run/dev", "@react-router/dev", "@solidjs/start", "@tanstack/react-start", "@tanstack/start", "@tanstack/solid-start", "vike", "vite-plugin-ssr", "@analogjs/platform", "@builder.io/qwik-city", "waku", "next"];

module.exports = {
  SOURCE_DATE,
  DOCS,
  PUBLIC_PREFIXES,
  PROVIDER_WORDS,
  PROVIDER_PAIRS,
  SECRET_WORDS,
  NON_SECRET_SUFFIXES,
  KEY_PATTERNS,
  PLACEHOLDER_RE,
  BROWSER_FLAG_SDKS,
  GEMINI_PACKAGES,
  FRAMEWORK_DEPS,
  VITE_SSR_DEPS,
};
