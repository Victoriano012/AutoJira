import { AppConfig, readConfig, writeConfig } from "@/lib/config";

export async function GET() {
  return Response.json(readConfig());
}

export async function PUT(req: Request) {
  const { model } = (await req.json()) as AppConfig;
  writeConfig({ ...readConfig(), model: model || undefined });
  return Response.json(readConfig());
}
