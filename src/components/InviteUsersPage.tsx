import { useState } from "react";

type InviteRole = "ADMIN" | "EDITOR" | "VIEWER";

type InviteEntry = {
  email: string;
  role: InviteRole;
};

interface InviteUsersPageProps {
  maxUsers: number;      // total seats allowed
  seatsUsed: number;     // current seats already used
  onBackToDashboard: () => void;
  onContinue: (invites: InviteEntry[]) => Promise<void>;
}

export function InviteUsersPage({
  maxUsers,
  seatsUsed,
  onBackToDashboard,
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
    <section className="app-content">
      <div className="app-card">
        <header className="app-header">
          <div>
            <h2 className="app-title">Invite Team Members</h2>
            <p className="app-subtitle">
              Add users and assign role-based access for your organization.
            </p>
          </div>
        </header>

        <div className="status-panel">
          Available seats: <strong>{Math.max(0, seatsRemaining)}</strong> of <strong>{maxUsers}</strong>.
        </div>

        <div className="app-stack spacer-top">
          {invites.map((invite, idx) => (
            <div key={idx} className="invite-row">
              <input
                className="field"
                type="email"
                placeholder="name@organization.com"
                value={invite.email}
                onChange={(e) => handleEmailChange(idx, e.target.value)}
              />
              <select
                className="select"
                value={invite.role}
                onChange={(e) => handleRoleChange(idx, e.target.value as InviteRole)}
              >
                <option value="VIEWER">View Only</option>
                <option value="EDITOR">Editor</option>
                <option value="ADMIN">Administrator</option>
              </select>
            </div>
          ))}
        </div>

        <div className="app-actions">
          <button className="button button-secondary" onClick={onBackToDashboard}>
            Back To Dashboard
          </button>

          {invites.length < seatsRemaining && (
            <button className="button button-secondary" onClick={addEmailField} disabled={loading}>
              Add Another User
            </button>
          )}

          <button className="button button-primary" onClick={handleSubmit} disabled={loading}>
            {loading ? "Sending..." : "Send Invites"}
          </button>

        </div>
      </div>
    </section>
  );
}
