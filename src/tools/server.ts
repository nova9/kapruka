import { tool, type ToolSet } from "ai";
import { mcpClient } from "@/lib/server/mcp-client";
import { TOOL_SPECS } from "./specs";
import type { CartItem } from "@/types";

async function callMcp(name: string, params: Record<string, unknown>) {
  try {
    const result = await mcpClient.callTool(name, params);
    console.log(`[MCP] ${name}`, JSON.stringify(params), "→", JSON.stringify(result));
    return result;
  } catch (err) {
    console.log(`[MCP] ${name} ERROR`, JSON.stringify(params), "→", (err as Error).message);
    return { error: (err as Error).message };
  }
}

function checkOrderAuthorization(
  args: Record<string, unknown>,
  serverCart: CartItem[],
): { error: string } | null {
  const serverCartIds = new Set(serverCart.map((i) => i.id));
  const orderCart = (args.cart ?? []) as Array<{ product_id: string }>;
  const unauthorizedIds = orderCart
    .map((item) => item.product_id)
    .filter((id) => !serverCartIds.has(id));
  if (unauthorizedIds.length > 0) {
    return {
      error: `Cannot checkout: product(s) [${unauthorizedIds.join(", ")}] are not in the cart. Add them to the cart first.`,
    };
  }
  return null;
}

/**
 * Single execution path for ALL tools, used by both the text agent
 * (/api/chat via buildChatTools) and the voice agent (/api/realtime-tools).
 * Always resolves to a result object — errors are returned as { error }
 * so the model can read them and self-correct.
 */
export async function executeServerTool(
  name: string,
  rawArgs: unknown,
  serverCart: CartItem[],
): Promise<unknown> {
  const spec = TOOL_SPECS[name];
  if (!spec) return { error: `Unknown tool: ${name}` };

  const parsed = spec.inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { error: `Invalid arguments for ${name}: ${parsed.error.message}` };
  }
  const args = parsed.data as Record<string, unknown>;

  if (name === "kapruka_create_order") {
    const authError = checkOrderAuthorization(args, serverCart);
    if (authError) return authError;
  }

  if (spec.execution === "client") return args;

  return callMcp(name, args);
}

export function buildChatTools(serverCart: CartItem[]): ToolSet {
  return Object.fromEntries(
    Object.entries(TOOL_SPECS).map(function toAiSdkTool([name, spec]) {
      return [
        name,
        tool({
          description: spec.description,
          inputSchema: spec.inputSchema,
          execute(params: unknown) {
            return executeServerTool(name, params, serverCart);
          },
        }),
      ];
    }),
  ) as ToolSet;
}
