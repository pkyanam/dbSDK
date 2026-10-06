import { cloudflare } from "blume/deploy";
import { cloudflare as cloudflareRateLimit } from "blume/ratelimit";
import { openai } from "blume/ai";
import { defineConfig } from "blume";

export default defineConfig({
  title: "dbSDK",
  description:
    "One typed PostgreSQL client for Supabase and Neon. Parameterized SQL, one result shape, explicit transports, and errors that never retry a write on their own.",
  logo: {
    image: "/brand/icon-v2.webp",
    text: "dbSDK",
  },

  content: {
    // All documentation lives in content/docs/ (docs agent): 13 pages under
    // /docs/*. The former top-level /getting-started and /capabilities stub
    // pages were removed; their old URLs 301-redirect below.
    root: "content",
  },

  // Legacy prototype URLs from the stub area keep resolving, straight to the
  // canonical full documentation. Exact redirects (no patterns, no catch-all):
  // the deleted stub pages' URLs only. Markdown mirrors move with the page
  // automatically (/getting-started.md -> /docs/getting-started.md).
  redirects: [
    { from: "/getting-started", to: "/docs/getting-started", status: 301 },
    { from: "/capabilities", to: "/docs/capabilities", status: 301 },
  ],

  theme: {
    accent: { light: "#c1121f", dark: "#669bbc" },
    action: "#c1121f",
    radius: "sm",
    mode: "system",
    fonts: {
      display: "space-grotesk",
      body: "space-grotesk",
      mono: "ibm-plex-mono",
    },
  },

  markdown: {
    code: {
      theme: {
        // Code panels sit on the navy token, so both modes read dark
        // token colors against it.
        light: "github-dark",
        dark: "github-dark",
      },
    },
  },

  agents: {
    llmsTxt: true,
    catalog: true,
    skillMd: true,
    mcp: {
      enabled: true,
      route: "/mcp",
    },
  },

  ai: {
    assistant: {
      enabled: true,
      provider: openai({
        // Cloudflare Workers AI, OpenAI-compatible endpoint. The key is read
        // from the Worker's WORKERS_AI_API_KEY binding/secret at request time;
        // it is never written into the build.
        baseUrl:
          "https://api.cloudflare.com/client/v4/accounts/98117dde620017491911477efef1efbb/ai/v1",
        apiKeyEnv: "WORKERS_AI_API_KEY",
        // Verified against the official Workers AI model catalog
        // (developers.cloudflare.com/workers-ai/models/glm-4.7-flash/):
        // 131,072-token context window, function calling supported,
        // instruction-following optimized, and the cheapest strong text
        // model on the catalog (no extra cost on the free daily tier).
        // Replaces @cf/meta/llama-3.1-8b-instruct-fp8, whose weak
        // instruction-following let answers invent adapter APIs.
        model: "@cf/zai-org/glm-4.7-flash",
        name: "workers-ai",
      }),
      // Validated against the official model catalog (function calling: Yes)
      // and empirically on the deployed Worker: glm-4.7-flash handles the
      // search_docs/read_page loop through the OpenAI-compatible endpoint,
      // so the assistant can read a whole page when an excerpt stops short.
      tools: true,
      suggestions: [
        { label: "What is dbSDK?" },
        { label: "Which transports support interactive transactions?" },
        { label: "How do I run queries without a database?" },
        { label: "How does dbSDK handle a failed write?" },
      ],
      instructions:
        "You are the dbSDK docs assistant. dbSDK is a typed PostgreSQL client " +
        "for Supabase and Neon. Answer only from the retrieved documentation, " +
        "keep answers short, and include runnable code only when that code " +
        "appears in the retrieved pages. The API has one authoritative shape, " +
        "so never deviate from it: `createDatabase` is imported from \"dbsdk\"; " +
        "the adapters are `supabase` from \"dbsdk/supabase\", `neon` from " +
        "\"dbsdk/neon\", and `postgres` from \"dbsdk/postgres\", each passed " +
        "to createDatabase as `adapter: <adapter>({...})`. The Supabase " +
        "adapter takes a `connectionString` (the `postgresql://` URL from the " +
        "Supabase dashboard, never an `https://` project URL) and " +
        "`connectionMode: \"direct\" | \"session\" | \"transaction\"`. Never " +
        "invent imports, function names, options, or connection formats that " +
        "are not in the retrieved pages, and never reach for other libraries " +
        "such as @supabase/supabase-js. Session state is qualified the same " +
        "way the docs qualify it: it holds only on a single dedicated, " +
        "leased connection — inside transaction() or a client leased via raw " +
        "— never across separate top-level pooled db.sql/db.query calls, " +
        "which may land on different pooled connections even in session " +
        "mode. Do not state pricing, billing, or cost claims, and do not " +
        "state performance or cost tradeoffs, unless the retrieved pages " +
        "state them; report them exactly as written, without elaboration. " +
        "If the retrieved pages do not contain " +
        "the code or option a question needs, say so and link the relevant " +
        "docs page instead of writing code from memory.",
      retrieval: {
        // Adapter pages run 2.4-6.3 KB of content, and one page often holds
        // the whole answer, so excerpts reach deep into a page while the
        // budget keeps the total injection modest for a model with a
        // 131k-token context window.
        maxResults: 6,
        excerptChars: 4000,
        contextBudget: 16000,
      },
    },
  },

  rateLimit: cloudflareRateLimit({ requests: 20, window: 60 }),

  seo: {
    og: {
      enabled: true,
      palette: {
        accent: "#c1121f",
        background: "#003049",
        foreground: "#fdf0d5",
        muted: "#669bbc",
        border: "#1d3a50",
      },
    },
    sitemap: true,
    robots: true,
    structuredData: true,
    software: {
      license: "MIT",
      operatingSystem: "Node.js 22+",
      sameAs: ["https://github.com/pkyanam/dbSDK"],
    },
  },

  deployment: cloudflare({
    // Canonical production host. All four domains (dbsdk.com, www.dbsdk.com,
    // database-sdk.dev, www.database-sdk.dev) serve this Worker through the
    // Vercel edge proxy; canonical URLs point at the apex.
    site: "https://dbsdk.com",
  }),

  github: {
    owner: "pkyanam",
    repo: "dbSDK",
  },

  footer: {
    links: [
      { label: "Docs", href: "/docs/getting-started" },
      { label: "Capabilities", href: "/docs/capabilities" },
      { label: "Agent surface", href: "/#agents" },
    ],
  },
});
