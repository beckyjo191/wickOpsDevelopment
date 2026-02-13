import { useAuthenticator } from "@aws-amplify/ui-react";

interface InventoryPageProps {
  canInviteMore: boolean;
  onInviteMore: () => void;
}

export function InventoryPage({ canInviteMore, onInviteMore }: InventoryPageProps) {
  const { user, signOut } = useAuthenticator() as any;

  return (
    <div style={{ padding: 32 }}>
      <h2>Inventory Page Placeholder</h2>
      <p>Welcome, {user?.attributes?.email ?? "User"}!</p>
      <p>Your subscription is active. 🎉</p>
      <p>This is where the inventory table will go.</p>
      {canInviteMore && (
        <>
          <button onClick={onInviteMore}>Invite More Users</button>
          <br />
          <br />
        </>
      )}
      <button onClick={signOut}>Sign Out</button>
    </div>
  );
}
