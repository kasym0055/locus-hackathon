import { createSessionHandler, productionSessionOptions } from "@/server/profile/session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: Request): Promise<Response> {
  return createSessionHandler(productionSessionOptions())(request);
}
