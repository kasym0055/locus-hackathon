import { createProfileHandler } from "@/server/profile/route-handler";
import { productionServices } from "@/server/profile/services";
import { productionSessionOptions } from "@/server/profile/session";
import { after } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: Request): Promise<Response> {
  return createProfileHandler({ ...productionSessionOptions(), services: productionServices, waitUntil: after })(request);
}
