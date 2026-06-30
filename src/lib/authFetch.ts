// src/lib/authFetch.ts
import { fetchAuthSession } from "aws-amplify/auth";

/** Last successfully resolved token — used by keepalive saves on page unload
 *  where we cannot await an async token refresh. */
let cachedToken: string | null = null;

export function getCachedAuthToken(): string | null {
  return cachedToken;
}

/** Header the backend reads to scope a PLATFORM_SUPPORT operator's reads to a
 *  specific customer org. Must match SUPPORT_ORG_HEADER in inventoryApi/config. */
const SUPPORT_ORG_HEADER = "x-wickops-support-org";

const SUPPORT_ORG_STORAGE_KEY = "wickops.support.actingAsOrg";

/** When a support operator is "acting as" a customer org, this holds that
 *  org id and authFetch attaches the support header to every request. Null in
 *  normal operation, so ordinary users never send the header. Persisted in
 *  sessionStorage so the mode survives a page reload (data refetches under the
 *  override) but never outlives the browser session. */
let supportOrgOverride: string | null = (() => {
  try {
    return sessionStorage.getItem(SUPPORT_ORG_STORAGE_KEY) || null;
  } catch {
    return null;
  }
})();

/** Enter/exit support "act as org" mode. Pass null to exit. Only meaningful
 *  for users in the PLATFORM_SUPPORT Cognito group; the backend ignores the
 *  header for everyone else and gates it on a live consent grant. */
export function setSupportOrgOverride(orgId: string | null): void {
  supportOrgOverride = orgId && orgId.trim() ? orgId.trim() : null;
  try {
    if (supportOrgOverride) sessionStorage.setItem(SUPPORT_ORG_STORAGE_KEY, supportOrgOverride);
    else sessionStorage.removeItem(SUPPORT_ORG_STORAGE_KEY);
  } catch {
    // sessionStorage unavailable — in-memory override still applies this session.
  }
}

export function getSupportOrgOverride(): string | null {
  return supportOrgOverride;
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
      ...(supportOrgOverride ? { [SUPPORT_ORG_HEADER]: supportOrgOverride } : {}),
    },
  });
}
