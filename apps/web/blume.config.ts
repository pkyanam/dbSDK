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
    // Top-level .mdx here is the web agent's canonical stub area; the full
    // documentation lives in content/docs/ (docs agent).
    root: "content",
  },

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
        model: "@cf/meta/llama-3.1-8b-instruct-fp8",
        name: "workers-ai",
      }),
      // Tools stay off: OpenAI-compatible endpoints default to no tool calling.
      suggestions: [
        { label: "What is dbSDK?" },
        { label: "Which transports support interactive transactions?" },
        { label: "How do I run queries without a database?" },
        { label: "How does dbSDK handle a failed write?" },
      ],
      instructions:
        "You are the dbSDK docs assistant. dbSDK is a typed PostgreSQL client for Supabase and Neon. Answer only from the retrieved documentation, keep answers short, and include runnable code where it helps.",
      retrieval: {
        maxResults: 4,
        excerptChars: 1500,
        contextBudget: 6000,
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
      { label: "Docs", href: "/getting-started" },
      { label: "Capabilities", href: "/capabilities" },
      { label: "Agent surface", href: "/#agents" },
    ],
  },
});
