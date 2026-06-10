import { NextRequest, NextResponse } from "next/server";
import { executeServerTool } from "@/tools/server";
import type { CartItem } from "@/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { tool_name, arguments: args, cart } = (await req.json()) as {
    tool_name: string;
    arguments: Record<string, unknown>;
    cart?: CartItem[];
  };

  try {
    const result = await executeServerTool(tool_name, args ?? {}, cart ?? []);
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
