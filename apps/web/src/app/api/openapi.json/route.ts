import { NextResponse } from "next/server";
import { openapi } from "@/lib/openapi";

export function GET() {
  return NextResponse.json(openapi);
}
