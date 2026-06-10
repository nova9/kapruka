const MCP_URL = "https://mcp.kapruka.com/mcp";
const CACHE_TTL = 30 * 60 * 1000; // 30 min
const SHORT_TTL = 60 * 1000; // 1 min for tracking/delivery
const NO_CACHE_TOOLS = new Set(["kapruka_create_order"]);
const SHORT_TTL_TOOLS = new Set([
  "kapruka_track_order",
  "kapruka_check_delivery",
]);

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

class KaprukaMCPClient {
  private sessionId: string | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private requestCounter = 0;
  private requestTimestamps: number[] = [];
  private cache = new Map<string, CacheEntry>();

  private async doInitialize(): Promise<void> {
    const resp = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "kapruka-concierge", version: "1.0.0" },
        },
      }),
    });

    this.sessionId = resp.headers.get("mcp-session-id");

    // Send notifications/initialized (fire-and-forget)
    fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    }).catch(() => {});

    this.initialized = true;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.doInitialize().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async checkRateLimit(): Promise<void> {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(
      (t) => now - t < 60_000,
    );
    if (this.requestTimestamps.length >= 58) {
      const oldest = this.requestTimestamps[0];
      const waitMs = 60_000 - (now - oldest) + 200;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.checkRateLimit();
    }
    this.requestTimestamps.push(Date.now());
  }

  private parseSSE(text: string): unknown {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const envelope = JSON.parse(raw);
        if (envelope.error) {
          throw new Error(envelope.error.message ?? "MCP error");
        }
        const content = envelope.result?.content;
        if (Array.isArray(content) && content[0]?.type === "text") {
          const innerText = content[0].text as string;
          if (innerText.startsWith("{") || innerText.startsWith("[")) {
            return JSON.parse(innerText);
          }
          return innerText;
        }
        if (envelope.result !== undefined) return envelope.result;
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
    return null;
  }

  async callTool(
    name: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // Always use response_format json for structured data
    const toolParams = { ...params, response_format: "json" };
    const cacheKey = `${name}:${JSON.stringify(toolParams)}`;

    console.log("### TOOL CALL ###\n", name, toolParams, "######\n");

    if (!NO_CACHE_TOOLS.has(name)) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.data;
      }
    }

    await this.ensureInitialized();
    await this.checkRateLimit();

    const id = ++this.requestCounter;

    const resp = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: { params: toolParams },
        },
      }),
    });

    // Handle session expiry — reinitialize once and retry
    if (resp.status === 404 || resp.status === 401) {
      this.initialized = false;
      this.initPromise = null;
      this.sessionId = null;
      await this.ensureInitialized();
      return this.callTool(name, params);
    }

    if (resp.status === 429) {
      throw new Error("KAPRUKA_RATE_LIMIT: Kapruka's servers are rate-limiting requests right now.");
    }

    const text = await resp.text();
    const result = this.parseSSE(text);

    if (!NO_CACHE_TOOLS.has(name) && result !== null) {
      const ttl = SHORT_TTL_TOOLS.has(name) ? SHORT_TTL : CACHE_TTL;
      this.cache.set(cacheKey, { data: result, expiresAt: Date.now() + ttl });
    }

    return result;
  }
}

// Module-level singleton — reused across warm serverless invocations
export const mcpClient = new KaprukaMCPClient();
