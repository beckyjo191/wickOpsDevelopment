import { authFetch } from "./authFetch";

const normalizeBaseUrl = (value?: string) => (value ?? "").replace(/\/+$/, "");
const INVITES_API_BASE_URL = normalizeBaseUrl(
  import.meta.env.VITE_INVITES_API_BASE_URL,
);

export type PendingInviteRole = "ADMIN" | "EDITOR" | "VIEWER";

export interface PendingInvite {
  email: string;
  displayName: string;
  role: PendingInviteRole;
  createdAt: string;
  expiresAt: string;
  invitedBy: string;
}

const requireBase = () => {
  if (!INVITES_API_BASE_URL) {
    throw new Error("Missing VITE_INVITES_API_BASE_URL");
  }
  return INVITES_API_BASE_URL;
};

export async function listPendingInvites(): Promise<PendingInvite[]> {
  const base = requireBase();
  const res = await authFetch(`${base}/pending-invites`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to load pending invites");
  }
  const data = await res.json();
  return Array.isArray(data?.invites) ? (data.invites as PendingInvite[]) : [];
}

export async function resendInvite(email: string): Promise<void> {
  const base = requireBase();
  const res = await authFetch(`${base}/resend-invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to resend invite");
  }
}

export async function cancelInvite(email: string): Promise<void> {
  const base = requireBase();
  const res = await authFetch(`${base}/cancel-invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to cancel invite");
  }
}
