import { useState } from "react";

type InviteRole = "ADMIN" | "EDITOR" | "VIEWER";

type InviteEntry = {
  email: string;
  role: InviteRole;
};

interface InviteUsersPageProps {
  signOut: () => void;
  maxUsers: number;      // total seats allowed
  seatsUsed: number;     // current seats already used
  userEmail: string;
  onContinue: (invites: InviteEntry[]) => Promise<void>;
}

export function InviteUsersPage({
  signOut,
  maxUsers,
  seatsUsed,
  userEmail,
  onContinue,
}: InviteUsersPageProps) {
  const seatsRemaining = maxUsers - seatsUsed;
  const [invites, setInvites] = useState<InviteEntry[]>([
    { email: "", role: "VIEWER" },
  ]);
  const [loading, setLoading] = useState(false);

  const addEmailField = () => {
    if (invites.length < seatsRemaining) {
      setInvites([...invites, { email: "", role: "VIEWER" }]);
    }
  };

  const handleEmailChange = (idx: number, value: string) => {
    const next = [...invites];
    next[idx] = { ...next[idx], email: value };
    setInvites(next);
  };

  const handleRoleChange = (idx: number, value: InviteRole) => {
    const next = [...invites];
    next[idx] = { ...next[idx], role: value };
    setInvites(next);
  };

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const validInvites = invites
        .map((invite) => ({
          email: invite.email.trim().toLowerCase(),
          role: invite.role,
        }))
        .filter((invite) => invite.email.length > 0);
      if (!validInvites.length) return alert("Please enter at least one email");

      await onContinue(validInvites);
    } catch (err) {
      console.error(err);
      alert("Failed to send invites.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 32 }}>
      <h2>Invite Users to Your Organization</h2>
      <p>
        Logged in as: <strong>{userEmail}</strong>
      </p>
      <p>
        You can invite up to <strong>{seatsRemaining}</strong> more users based on your subscription plan.
      </p>

      {invites.map((invite, idx) => (
        <div key={idx} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            type="email"
            placeholder="Enter email"
            value={invite.email}
            onChange={(e) => handleEmailChange(idx, e.target.value)}
            style={{ padding: 8, width: 300 }}
          />
          <select
            value={invite.role}
            onChange={(e) => handleRoleChange(idx, e.target.value as InviteRole)}
            style={{ padding: 8 }}
          >
            <option value="VIEWER">Read Only</option>
            <option value="EDITOR">Read / Write</option>
            <option value="ADMIN">Admin</option>
          </select>
        </div>
      ))}

      {invites.length < seatsRemaining && (
        <button onClick={addEmailField} disabled={loading}>
          Add another email
        </button>
      )}

      <br /><br />

      <button onClick={handleSubmit} disabled={loading}>
        Continue
      </button>
      <br /><br />
      <button onClick={signOut}>Sign Out</button>
    </div>
  );
}
