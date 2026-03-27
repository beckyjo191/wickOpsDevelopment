// src/lib/authFetch.ts
import { fetchAuthSession } from "aws-amplify/auth";

/** Last successfully resolved token — used by keepalive saves on page unload
 *  where we cannot await an async token refresh. */
let cachedToken: string | null = null;

export function getCachedAuthToken(): string | null {
  return cachedToken;
}

export async function authFetch(
  url: string,
  options: RequestInit = {}
) {
  const session = await fetchAuthSession();

  const token = session.tokens?.idToken?.toString();
  if (!token) {
    throw new Error("No auth token available");
  }

  cachedToken = token;

  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
}
