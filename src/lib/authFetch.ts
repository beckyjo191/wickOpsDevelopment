// src/lib/authFetch.ts
import { fetchAuthSession } from "aws-amplify/auth";

export async function authFetch(
  url: string,
  options: RequestInit = {}
) {
  const session = await fetchAuthSession();

  const token = session.tokens?.idToken?.toString();
  if (!token) {
    throw new Error("No auth token available");
  }

  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
}
