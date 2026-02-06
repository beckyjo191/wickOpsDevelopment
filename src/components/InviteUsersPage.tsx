import { useState } from "react";

interface InviteUsersPageProps {
  signOut: () => void;
  maxUsers: number;      // total seats allowed
  seatsUsed: number;     // current seats already used
  userEmail: string;
}

export function InviteUsersPage({
  signOut,
  maxUsers,
  seatsUsed,
  userEmail,  
}: InviteUsersPageProps) {
  const seatsRemaining = maxUsers - seatsUsed;
  const [emails, setEmails] = useState<string[]>([""]);
  const [loading, setLoading] = useState(false);

  const addEmailField = () => {
    if (emails.length < seatsRemaining) setEmails([...emails, ""]);
  };

  const handleChange = (idx: number, value: string) => {
    const newEmails = [...emails];
    newEmails[idx] = value;
    setEmails(newEmails);
  };

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const validEmails = emails.filter((e) => e);
      if (!validEmails.length) return alert("Please enter at least one email");

      // TODO: call Lambda to create invites
      console.log("Inviting emails:", validEmails);

      // Redirect to inventory or another page
      window.location.href = "/inventory";
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

      {emails.map((email, idx) => (
        <input
          key={idx}
          type="email"
          placeholder="Enter email"
          value={email}
          onChange={(e) => handleChange(idx, e.target.value)}
          style={{ display: "block", marginBottom: 8, padding: 8, width: 300 }}
        />
      ))}

      {emails.length < seatsRemaining && (
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
