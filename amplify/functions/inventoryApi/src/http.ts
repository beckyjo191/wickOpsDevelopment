// ── Foundation: http.ts ─────────────────────────────────────────────────────
// CORS config and HTTP helpers extracted from handler.ts.

import { DEPLOYMENT_ENV } from "./config";

export const CORS_ALLOW_ORIGIN =
  DEPLOYMENT_ENV === "prod" || DEPLOYMENT_ENV === "production"
    ? "https://systems.wickops.com"
    : "http://localhost:5173";

export const CORS_ALLOW_HEADERS = "Authorization,Content-Type";

export const corsHeaders = {
  "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
  "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  Vary: "Origin",
};

export const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    ...corsHeaders,
  },
  body: JSON.stringify(body),
});

export const parseBody = (event: any): any => {
  if (!event?.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

export const getPath = (event: any): string =>
  String(event?.rawPath ?? event?.path ?? event?.requestContext?.http?.path ?? "");

export const getMethod = (event: any): string =>
  String(event?.requestContext?.http?.method ?? event?.httpMethod ?? "").toUpperCase();

export const getQueryString = (event: any): Record<string, string | undefined> =>
  (event?.queryStringParameters ?? {}) as Record<string, string | undefined>;

export const parseNextToken = (value: string | undefined): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
};

export const encodeNextToken = (value: Record<string, unknown> | undefined): string | null => {
  if (!value) return null;
  return Buffer.from(JSON.stringify(value)).toString("base64");
};
