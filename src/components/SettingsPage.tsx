import { useEffect, useState } from "react";
import {
  confirmUserAttribute,
  fetchAuthSession,
  updateUserAttributes,
} from "aws-amplify/auth";
import {
  addInventoryLocation,
  createBillingPortalSession,
  createInventoryColumn,
  deleteInventoryColumn,
  listModuleAccessUsers,
  loadInventoryBootstrap,
  type ModuleAccessUser,
  type AppModuleKey,
  removeInventoryLocation,
  renameInventoryLocation,
  revokeUserAccess,
  syncCurrentUserEmail,
  updateUserModuleAccess,
  updateCurrentUserDisplayName,
  updateInventoryColumnLabel,
  updateInventoryColumnVisibility,
  type InventoryColumn,
  type InventoryRow,
} from "../lib/inventoryApi";
import type { ThemePreference } from "../lib/themePreference";

const SETTINGS_DISCLOSURES_STORAGE_KEY = "wickops.settings.disclosures";
type DisclosureKey = "appearance" | "userModuleAccess" | "locations" | "inventoryColumns";
type DisclosureState = Record<DisclosureKey, boolean>;
const DEFAULT_DISCLOSURE_STATE: DisclosureState = {
  appearance: true,
  userModuleAccess: true,
  locations: true,
  inventoryColumns: false,
};

interface SettingsPageProps {
  currentDisplayName: string;
  currentUserEmail: string;
  canInviteMore: boolean;
  seatsRemaining: number;
  seatLimit: number;
  seatsUsed: number;
  canManageInventoryColumns: boolean;
  canManageModuleAccess: boolean;
  currentUserId: string;
  themePreference: ThemePreference;
  onThemePreferenceChange: (preference: ThemePreference) => void;
  onCurrentUserAllowedModulesChange: (allowedModules: AppModuleKey[]) => void;
  onCurrentUserDisplayNameChange: (displayName: string) => void;
  onCurrentUserEmailChange: (email: string) => void;
  onUserRevoked: (userId: string, newSeatsUsed: number) => void;
  onInviteUsers: () => void;
  userName?: string;
  onLogout?: () => void;
}

export function SettingsPage({
  currentDisplayName,
  currentUserEmail,
  canInviteMore,
  seatsRemaining,
  seatLimit,
  seatsUsed,
  canManageInventoryColumns,
  canManageModuleAccess,
  currentUserId,
  themePreference,
  onThemePreferenceChange,
  onCurrentUserAllowedModulesChange,
  onCurrentUserDisplayNameChange,
  onCurrentUserEmailChange,
  onUserRevoked,
  onInviteUsers,
  userName,
  onLogout,
}: SettingsPageProps) {
  const normalizeEmail = (value: string): string => value.trim().toLowerCase();
  const nonEditableKeys = new Set(["itemName", "quantity", "minQuantity", "expirationDate"]);
  const isLockedColumn = (column: InventoryColumn): boolean =>
    column.isCore || column.isRequired || nonEditableKeys.has(column.key);
  const [columns, setColumns] = useState<InventoryColumn[]>([]);
  const [newColumnName, setNewColumnName] = useState("");
  const [inventoryColumnSearchTerm, setInventoryColumnSearchTerm] = useState("");
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [savingColumn, setSavingColumn] = useState(false);
  const [pendingDeleteColumnId, setPendingDeleteColumnId] = useState<string | null>(null);
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [displayNameInput, setDisplayNameInput] = useState(currentDisplayName);
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const [emailInput, setEmailInput] = useState(currentUserEmail);
  const [editingEmail, setEditingEmail] = useState(false);
  const [pendingEmailVerification, setPendingEmailVerification] = useState(false);
  const [emailVerificationCode, setEmailVerificationCode] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);
  const [verifyingEmail, setVerifyingEmail] = useState(false);
  const [moduleAccessUsers, setModuleAccessUsers] = useState<ModuleAccessUser[]>([]);
  const [moduleAccessKeys, setModuleAccessKeys] = useState<AppModuleKey[]>(["inventory", "usage"]);
  const [loadingModuleAccess, setLoadingModuleAccess] = useState(false);
  const [savingModuleAccessUserId, setSavingModuleAccessUserId] = useState<string | null>(null);
  const [revokingUserId, setRevokingUserId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string>("");
  const [portalLoading, setPortalLoading] = useState(false);
  const [registeredLocations, setRegisteredLocations] = useState<string[]>([]);
  const [inventoryRows, setInventoryRows] = useState<InventoryRow[]>([]);
  const [newLocationName, setNewLocationName] = useState("");
  const [savingLocation, setSavingLocation] = useState(false);
  const [editingLocationName, setEditingLocationName] = useState<string | null>(null);
  const [editingLocationValue, setEditingLocationValue] = useState("");
  const [pendingDeleteLocation, setPendingDeleteLocation] = useState<string | null>(null);
  const [disclosures, setDisclosures] = useState<DisclosureState>(DEFAULT_DISCLOSURE_STATE);
  const [loadedDisclosureKey, setLoadedDisclosureKey] = useState<string>("");
  const disclosureStorageKey = `${SETTINGS_DISCLOSURES_STORAGE_KEY}.${currentUserId || "anonymous"}`;

  useEffect(() => {
    let cancelled = false;

    const loadColumns = async () => {
      setLoadingColumns(true);
      try {
        const bootstrap = await loadInventoryBootstrap();
        if (!cancelled) {
          setColumns(
            [...bootstrap.columns].sort(
              (a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0),
            ),
          );
          setRegisteredLocations(bootstrap.registeredLocations ?? []);
          setInventoryRows(bootstrap.items ?? []);
        }
      } catch (err) {
        console.error(err);
      } finally {
        if (!cancelled) setLoadingColumns(false);
      }
    };

    loadColumns();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setDisplayNameInput(currentDisplayName);
    setEditingDisplayName(false);
  }, [currentDisplayName]);

  useEffect(() => {
    setEmailInput(currentUserEmail);
    setEditingEmail(false);
    setPendingEmailVerification(false);
    setEmailVerificationCode("");
  }, [currentUserEmail]);

  useEffect(() => {
    if (!canManageModuleAccess) return;
    let cancelled = false;

    const loadModuleAccess = async () => {
      setLoadingModuleAccess(true);
      try {
        const data = await listModuleAccessUsers();
        if (!cancelled) {
          setModuleAccessUsers(data.users);
          setModuleAccessKeys(data.modules.length > 0 ? data.modules : ["inventory", "usage"]);
        }
      } catch (err) {
        console.error(err);
      } finally {
        if (!cancelled) setLoadingModuleAccess(false);
      }
    };

    void loadModuleAccess();
    return () => {
      cancelled = true;
    };
  }, [canManageModuleAccess]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(disclosureStorageKey);
      if (!raw) {
        setDisclosures(DEFAULT_DISCLOSURE_STATE);
        setLoadedDisclosureKey(disclosureStorageKey);
        return;
      }
      const parsed = JSON.parse(raw) as Partial<DisclosureState>;
      setDisclosures({
        appearance: typeof parsed.appearance === "boolean" ? parsed.appearance : DEFAULT_DISCLOSURE_STATE.appearance,
        userModuleAccess:
          typeof parsed.userModuleAccess === "boolean"
            ? parsed.userModuleAccess
            : DEFAULT_DISCLOSURE_STATE.userModuleAccess,
        locations:
          typeof parsed.locations === "boolean"
            ? parsed.locations
            : DEFAULT_DISCLOSURE_STATE.locations,
        inventoryColumns:
          typeof parsed.inventoryColumns === "boolean"
            ? parsed.inventoryColumns
            : DEFAULT_DISCLOSURE_STATE.inventoryColumns,
      });
      setLoadedDisclosureKey(disclosureStorageKey);
    } catch {
      setDisclosures(DEFAULT_DISCLOSURE_STATE);
      setLoadedDisclosureKey(disclosureStorageKey);
    }
  }, [disclosureStorageKey]);

  useEffect(() => {
    if (loadedDisclosureKey !== disclosureStorageKey) return;
    try {
      window.localStorage.setItem(disclosureStorageKey, JSON.stringify(disclosures));
    } catch {
      // ignore storage failures
    }
  }, [disclosureStorageKey, disclosures, loadedDisclosureKey]);

  // Derive merged location list: registered + from item data
  const allLocations = (() => {
    const fromItems = new Set(
      inventoryRows
        .map((r) => String(r.values.location ?? "").trim())
        .filter((v) => v.length > 0),
    );
    const merged = new Set([...registeredLocations, ...fromItems]);
    return Array.from(merged).sort((a, b) => a.localeCompare(b));
  })();

  const getItemCountForLocation = (loc: string): number =>
    inventoryRows.filter((r) => String(r.values.location ?? "").trim() === loc).length;

  const onAddLocation = async () => {
    const name = newLocationName.trim();
    if (!name) return;
    setSavingLocation(true);
    try {
      const locs = await addInventoryLocation(name);
      setRegisteredLocations(locs);
      setNewLocationName("");
    } catch (err) {
      console.error(err);
    } finally {
      setSavingLocation(false);
    }
  };

  const onRenameLocation = async (oldName: string) => {
    const newName = editingLocationValue.trim();
    if (!newName || newName === oldName) {
      setEditingLocationName(null);
      return;
    }
    setSavingLocation(true);
    try {
      const result = await renameInventoryLocation(oldName, newName);
      setRegisteredLocations(result.locations);
      // Update local row data to reflect the rename
      setInventoryRows((prev) =>
        prev.map((r) => {
          if (String(r.values.location ?? "").trim() === oldName) {
            return { ...r, values: { ...r.values, location: newName } };
          }
          return r;
        }),
      );
      setEditingLocationName(null);
    } catch (err) {
      console.error(err);
    } finally {
      setSavingLocation(false);
    }
  };

  const onRemoveLocation = async (name: string) => {
    setSavingLocation(true);
    try {
      const locs = await removeInventoryLocation(name);
      setRegisteredLocations(locs);
      setPendingDeleteLocation(null);
    } catch (err) {
      console.error(err);
    } finally {
      setSavingLocation(false);
    }
  };

  const onAddColumn = async () => {
    if (!canManageInventoryColumns || !newColumnName.trim()) return;
    setSavingColumn(true);
    try {
      const created = await createInventoryColumn({
        label: newColumnName.trim(),
      });
      setColumns((prev) => [...prev, created].sort((a, b) => a.sortOrder - b.sortOrder));
      setNewColumnName("");
    } catch (err: any) {
      alert(err?.message ?? "Failed to add column");
    } finally {
      setSavingColumn(false);
    }
  };

  const onDeleteColumn = async (columnId: string) => {
    if (!canManageInventoryColumns) return;
    setSavingColumn(true);
    try {
      await deleteInventoryColumn(columnId);
      setColumns((prev) => prev.filter((item) => item.id !== columnId));
      setPendingDeleteColumnId(null);
    } catch (err: any) {
      alert(err?.message ?? "Failed to remove column");
    } finally {
      setSavingColumn(false);
    }
  };

  const onToggleColumnVisibility = async (column: InventoryColumn) => {
    if (!canManageInventoryColumns) return;
    setSavingColumn(true);
    try {
      await updateInventoryColumnVisibility(column.id, !column.isVisible);
      setColumns((prev) =>
        prev.map((item) =>
          item.id === column.id ? { ...item, isVisible: !item.isVisible } : item,
        ),
      );
    } catch (err: any) {
      alert(err?.message ?? "Failed to update column visibility");
    } finally {
      setSavingColumn(false);
    }
  };

  const onStartEditColumn = (column: InventoryColumn) => {
    setEditingColumnId(column.id);
    setEditingLabel(column.label);
  };

  const onCancelEditColumn = () => {
    setEditingColumnId(null);
    setEditingLabel("");
  };

  const onSaveEditColumn = async (column: InventoryColumn) => {
    if (!canManageInventoryColumns) return;
    const nextLabel = editingLabel.trim();
    if (!nextLabel) return;
    if (nextLabel === column.label) {
      onCancelEditColumn();
      return;
    }
    setSavingColumn(true);
    try {
      await updateInventoryColumnLabel(column.id, nextLabel);
      setColumns((prev) =>
        prev.map((item) => (item.id === column.id ? { ...item, label: nextLabel } : item)),
      );
      onCancelEditColumn();
    } catch (err: any) {
      alert(err?.message ?? "Failed to update column label");
    } finally {
      setSavingColumn(false);
    }
  };

  const onToggleUserModule = async (
    targetUserId: string,
    moduleKey: AppModuleKey,
    checked: boolean,
  ) => {
    if (!canManageModuleAccess) return;
    const user = moduleAccessUsers.find((item) => item.userId === targetUserId);
    if (!user) return;
    const next = new Set(user.allowedModules ?? []);
    if (checked) {
      next.add(moduleKey);
    } else {
      next.delete(moduleKey);
    }
    if (next.size === 0) {
      alert("Users must have access to at least one module. Use \"Revoke Access\" to remove a user entirely.");
      return;
    }
    const nextAllowedModules = Array.from(next) as AppModuleKey[];

    setModuleAccessUsers((prev) =>
      prev.map((item) =>
        item.userId === targetUserId ? { ...item, allowedModules: nextAllowedModules } : item,
      ),
    );

    setSavingModuleAccessUserId(targetUserId);
    try {
      await updateUserModuleAccess(targetUserId, nextAllowedModules);
      if (targetUserId === currentUserId) {
        onCurrentUserAllowedModulesChange(nextAllowedModules);
      }
    } catch (err: any) {
      setModuleAccessUsers((prev) =>
        prev.map((item) =>
          item.userId === targetUserId ? { ...item, allowedModules: user.allowedModules } : item,
        ),
      );
      alert(err?.message ?? "Failed to update module access");
    } finally {
      setSavingModuleAccessUserId(null);
    }
  };

  const onRevokeUser = async (userId: string) => {
    if (!window.confirm("Revoke this user's access? They will lose access to the organization and their seat will be freed.")) return;
    setRevokingUserId(userId);
    setRevokeError("");
    try {
      const result = await revokeUserAccess(userId);
      setModuleAccessUsers((prev) => prev.filter((u) => u.userId !== userId));
      onUserRevoked(userId, result.seatsUsed);
    } catch (err: any) {
      setRevokeError(err?.message ?? "Failed to revoke access. Please try again.");
    } finally {
      setRevokingUserId(null);
    }
  };

  const onSaveDisplayName = async () => {
    const nextDisplayName = displayNameInput.trim();
    if (!nextDisplayName) {
      alert("Name is required.");
      return;
    }
    if (nextDisplayName === currentDisplayName.trim()) return;
    setSavingDisplayName(true);
    try {
      await updateCurrentUserDisplayName(nextDisplayName);
      onCurrentUserDisplayNameChange(nextDisplayName);
      setEditingDisplayName(false);
    } catch (err: any) {
      alert(err?.message ?? "Failed to update your name");
    } finally {
      setSavingDisplayName(false);
    }
  };

  const onCancelDisplayNameEdit = () => {
    setDisplayNameInput(currentDisplayName);
    setEditingDisplayName(false);
  };

  const isValidEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

  const onStartEmailEdit = () => {
    setEmailInput(currentUserEmail);
    setPendingEmailVerification(false);
    setEmailVerificationCode("");
    setEditingEmail(true);
  };

  const onCancelEmailEdit = () => {
    setEmailInput(currentUserEmail);
    setPendingEmailVerification(false);
    setEmailVerificationCode("");
    setEditingEmail(false);
  };

  const onSendEmailVerification = async () => {
    const nextEmail = normalizeEmail(emailInput);
    if (!isValidEmail(nextEmail)) {
      alert("Please enter a valid email address.");
      return;
    }
    if (nextEmail === normalizeEmail(currentUserEmail)) {
      onCancelEmailEdit();
      return;
    }

    setSavingEmail(true);
    try {
      const output = await updateUserAttributes({
        userAttributes: {
          email: nextEmail,
        },
      });
      const emailNextStep = output.email?.nextStep?.updateAttributeStep;
      if (emailNextStep === "DONE") {
        const sync = await syncCurrentUserEmail();
        onCurrentUserEmailChange(sync.email);
        setEditingEmail(false);
        setPendingEmailVerification(false);
        setEmailVerificationCode("");
        return;
      }
      setPendingEmailVerification(true);
    } catch (err: any) {
      alert(err?.message ?? "Failed to start email update.");
    } finally {
      setSavingEmail(false);
    }
  };

  const onConfirmEmailVerification = async () => {
    const code = emailVerificationCode.trim();
    if (!code) {
      alert("Enter the verification code.");
      return;
    }
    setVerifyingEmail(true);
    try {
      await confirmUserAttribute({
        userAttributeKey: "email",
        confirmationCode: code,
      });
      await fetchAuthSession({ forceRefresh: true });
      const sync = await syncCurrentUserEmail();
      onCurrentUserEmailChange(sync.email);
      setEditingEmail(false);
      setPendingEmailVerification(false);
      setEmailVerificationCode("");
    } catch (err: any) {
      alert(err?.message ?? "Failed to verify email code.");
    } finally {
      setVerifyingEmail(false);
    }
  };

  const onDisclosureToggle = (key: DisclosureKey, isOpen: boolean) => {
    setDisclosures((prev) => {
      if (prev[key] === isOpen) return prev;
      return { ...prev, [key]: isOpen };
    });
  };

  const normalizedInventoryColumnSearch = inventoryColumnSearchTerm.trim().toLowerCase();
  const filteredInventoryColumns = columns.filter((column) => {
    if (!normalizedInventoryColumnSearch) return true;
    const label = String(column.label ?? "").toLowerCase();
    const key = String(column.key ?? "").toLowerCase();
    return label.includes(normalizedInventoryColumnSearch) || key.includes(normalizedInventoryColumnSearch);
  });

  return (
    <section className="app-content">
      <div className="app-card">
        <header className="app-header">
          <div>
            <h2 className="app-title">Organization Settings</h2>
            <p className="app-subtitle">Manage account profile, modules, and team access settings.</p>
          </div>
          <div className="app-actions">
            <button
              className="button button-primary"
              onClick={onInviteUsers}
              disabled={!canInviteMore}
            >
              Invite More Users
            </button>
          </div>
        </header>

        {(userName || onLogout) && (
          <div className="settings-logged-in">
            {userName && <span className="settings-logged-in-text">Logged in as <strong>{userName}</strong></span>}
            {onLogout && (
              <button type="button" className="settings-logout-link" onClick={onLogout}>
                Log Out
              </button>
            )}
          </div>
        )}

        <div className="status-panel">
          {seatsRemaining > 0
            ? `You have ${seatsRemaining} seat${seatsRemaining === 1 ? "" : "s"} remaining (${seatsUsed}/${seatLimit} seats used).`
            : `No seats remaining (${seatsUsed}/${seatLimit} seats used).`}
        </div>

        {canManageModuleAccess ? (
          <div className="settings-section spacer-top">
            <h3 className="settings-section-title">Subscription</h3>
            <p className="settings-section-copy">
              Add seats, change your plan, or update payment info via the billing portal.
            </p>
            <button
              className="button button-secondary"
              type="button"
              disabled={portalLoading}
              onClick={() => {
                setPortalLoading(true);
                createBillingPortalSession()
                  .then((url) => {
                    window.location.href = url;
                  })
                  .catch((err: any) => {
                    alert(err?.message ?? "Could not open billing portal. Please try again.");
                    setPortalLoading(false);
                  });
              }}
            >
              {portalLoading ? "Opening…" : "Manage Subscription"}
            </button>
          </div>
        ) : null}

        <details
          className="settings-section spacer-top"
          open
        >
          <summary className="settings-section-title">Profile</summary>
          <p className="settings-section-copy">
            Update your display name.
          </p>
          <div className="settings-columns-add settings-columns-add-inline">
            <input
              className={`field settings-profile-field${!editingDisplayName ? " settings-profile-field-locked" : ""}`}
              type="text"
              placeholder="Your name"
              value={displayNameInput}
              onChange={(event) => setDisplayNameInput(event.target.value)}
              disabled={!editingDisplayName || savingDisplayName}
            />
            {!editingDisplayName ? (
              <div className="settings-action-wrap">
                <button
                  className="settings-action-icon"
                  onClick={() => setEditingDisplayName(true)}
                  aria-label="Edit name"
                  type="button"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 16.75V20h3.25l9.58-9.58-3.25-3.25L4 16.75Zm12.62-10.87 1.5-1.5a1 1 0 0 1 1.42 0l1.58 1.58a1 1 0 0 1 0 1.42l-1.5 1.5-3-3Z" />
                  </svg>
                </button>
                <span className="settings-action-tip" role="tooltip">Edit</span>
              </div>
            ) : (
              <span className="settings-column-edit">
                <button
                  className="button button-secondary settings-inline-action"
                  type="button"
                  onClick={() => void onSaveDisplayName()}
                  disabled={savingDisplayName || !displayNameInput.trim()}
                >
                  {savingDisplayName ? "Saving..." : "Save"}
                </button>
                <button
                  className="button button-ghost settings-inline-action"
                  type="button"
                  onClick={onCancelDisplayNameEdit}
                  disabled={savingDisplayName}
                >
                  Cancel
                </button>
              </span>
            )}
          </div>

          <div className="settings-columns-add settings-columns-add-inline spacer-top">
            <input
              className={`field settings-profile-field${!editingEmail ? " settings-profile-field-locked" : ""}`}
              type="email"
              placeholder="your@email.com"
              value={emailInput}
              onChange={(event) => setEmailInput(event.target.value)}
              disabled={!editingEmail || savingEmail || verifyingEmail}
            />
            {!editingEmail ? (
              <div className="settings-action-wrap">
                <button
                  className="settings-action-icon"
                  onClick={onStartEmailEdit}
                  aria-label="Edit email"
                  type="button"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 16.75V20h3.25l9.58-9.58-3.25-3.25L4 16.75Zm12.62-10.87 1.5-1.5a1 1 0 0 1 1.42 0l1.58 1.58a1 1 0 0 1 0 1.42l-1.5 1.5-3-3Z" />
                  </svg>
                </button>
                <span className="settings-action-tip" role="tooltip">Edit</span>
              </div>
            ) : (
              <span className="settings-column-edit">
                <button
                  className="button button-secondary settings-inline-action"
                  type="button"
                  onClick={() => void onSendEmailVerification()}
                  disabled={savingEmail || verifyingEmail || !normalizeEmail(emailInput)}
                >
                  {savingEmail ? "Sending..." : "Verify"}
                </button>
                <button
                  className="button button-ghost settings-inline-action"
                  type="button"
                  onClick={onCancelEmailEdit}
                  disabled={savingEmail || verifyingEmail}
                >
                  Cancel
                </button>
              </span>
            )}
          </div>
          {editingEmail && pendingEmailVerification ? (
            <div className="settings-columns-add settings-columns-add-inline spacer-top">
              <input
                className="field settings-profile-field"
                type="text"
                placeholder="Verification code"
                value={emailVerificationCode}
                onChange={(event) => setEmailVerificationCode(event.target.value)}
                disabled={verifyingEmail}
              />
              <button
                className="button button-secondary settings-inline-action"
                type="button"
                onClick={() => void onConfirmEmailVerification()}
                disabled={verifyingEmail || !emailVerificationCode.trim()}
              >
                {verifyingEmail ? "Confirming..." : "Confirm"}
              </button>
            </div>
          ) : null}
        </details>

        <details
          className="settings-section spacer-top"
          open={disclosures.appearance}
          onToggle={(event) => onDisclosureToggle("appearance", event.currentTarget.open)}
        >
          <summary className="settings-section-title">Appearance</summary>
          <p className="settings-section-copy">
            Choose how WickOps should look on this device.
          </p>
          <div className="settings-theme-options" role="radiogroup" aria-label="Theme preference">
            <label className="settings-theme-option">
              <input
                type="radio"
                name="theme-preference"
                value="system"
                checked={themePreference === "system"}
                onChange={() => onThemePreferenceChange("system")}
              />
              <span>System</span>
            </label>
            <label className="settings-theme-option">
              <input
                type="radio"
                name="theme-preference"
                value="light"
                checked={themePreference === "light"}
                onChange={() => onThemePreferenceChange("light")}
              />
              <span>Light</span>
            </label>
            <label className="settings-theme-option">
              <input
                type="radio"
                name="theme-preference"
                value="dark"
                checked={themePreference === "dark"}
                onChange={() => onThemePreferenceChange("dark")}
              />
              <span>Dark</span>
            </label>
          </div>
        </details>


        <details
          className="settings-section spacer-top"
          open={disclosures.userModuleAccess}
          onToggle={(event) => onDisclosureToggle("userModuleAccess", event.currentTarget.open)}
        >
          <summary className="settings-section-title">User Module Access</summary>
          <p className="settings-section-copy">
            Admins can control which modules each user can access.
          </p>
          {canManageModuleAccess ? (
            <div className="settings-columns-list">
              {loadingModuleAccess ? <div>Loading users...</div> : null}
              {!loadingModuleAccess && moduleAccessUsers.length === 0 ? <div>No users found.</div> : null}
              {moduleAccessUsers.map((user) => (
                <div className="settings-column-row" key={`module-access-${user.userId}`}>
                  <div className="settings-column-visibility">
                    <span>
                      {user.displayName?.trim() || user.email || user.userId}
                    </span>
                    <span className="settings-core-pill">{user.role}</span>
                    {user.userId === currentUserId ? <span className="settings-core-pill">You</span> : null}
                  </div>
                  <div className="settings-column-actions">
                    {moduleAccessKeys.map((moduleKey) => {
                      const normalizedCurrentEmail = normalizeEmail(currentUserEmail);
                      const normalizedUserEmail = normalizeEmail(user.email);
                      const normalizedUserIdAsEmail = normalizeEmail(user.userId);
                      const isSelf =
                        user.userId === currentUserId ||
                        (!!normalizedCurrentEmail &&
                          (normalizedUserEmail === normalizedCurrentEmail ||
                            normalizedUserIdAsEmail === normalizedCurrentEmail));
                      const isChecked = user.allowedModules.includes(moduleKey);
                      return (
                      <label
                        className={`settings-column-select${isSelf ? " settings-column-select-disabled" : ""}`}
                        key={`${user.userId}-${moduleKey}`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={savingModuleAccessUserId === user.userId || isSelf}
                          onChange={(event) =>
                            void onToggleUserModule(user.userId, moduleKey, event.target.checked)
                          }
                        />
                        <span>{moduleKey === "usage" ? "Usage" : "Inventory"}</span>
                      </label>
                      );
                    })}
                    {user.userId !== currentUserId && !["OWNER", "ACCOUNT_OWNER"].includes(user.role.toUpperCase()) && (
                      <button
                        type="button"
                        className="button button-ghost button-sm"
                        disabled={revokingUserId === user.userId || savingModuleAccessUserId === user.userId}
                        onClick={() => { void onRevokeUser(user.userId); }}
                      >
                        {revokingUserId === user.userId ? "Revoking…" : "Revoke Access"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {revokeError && <p className="settings-error">{revokeError}</p>}
            </div>
          ) : (
            <p className="settings-section-copy">
              Only administrators can manage module access.
            </p>
          )}
        </details>

        <details
          className="settings-section spacer-top"
          open={disclosures.locations}
          onToggle={(event) => onDisclosureToggle("locations", event.currentTarget.open)}
        >
          <summary className="settings-section-title">Locations</summary>
          {canManageInventoryColumns ? (
            <>
              <p className="settings-section-copy">
                Manage inventory locations. Renaming a location updates all items assigned to it.
              </p>
              <div className="settings-columns-add settings-columns-add-inline" style={{ marginBottom: "0.75rem" }}>
                <input
                  className="field"
                  placeholder="New location name"
                  value={newLocationName}
                  onChange={(e) => setNewLocationName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void onAddLocation(); }}
                />
                <button
                  className="button button-secondary"
                  onClick={() => void onAddLocation()}
                  disabled={savingLocation || !newLocationName.trim()}
                >
                  Add Location
                </button>
              </div>
              <div className="settings-columns-list">
                {loadingColumns ? <div>Loading locations...</div> : null}
                {!loadingColumns && allLocations.length === 0 ? (
                  <div className="settings-section-copy">No locations yet. Add one above.</div>
                ) : null}
                {allLocations.map((loc) => {
                  const itemCount = getItemCountForLocation(loc);
                  return (
                    <div key={loc} className="settings-column-row">
                      <div className="settings-column-visibility">
                        {editingLocationName === loc ? (
                          <span className="settings-column-edit">
                            <input
                              className="field settings-column-edit-input"
                              value={editingLocationValue}
                              onChange={(e) => setEditingLocationValue(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") void onRenameLocation(loc); if (e.key === "Escape") setEditingLocationName(null); }}
                              disabled={savingLocation}
                              autoFocus
                            />
                            <button
                              className="button button-secondary settings-inline-action"
                              onClick={() => void onRenameLocation(loc)}
                              disabled={savingLocation || !editingLocationValue.trim()}
                              type="button"
                            >
                              Save
                            </button>
                            <button
                              className="button button-ghost settings-inline-action"
                              onClick={() => setEditingLocationName(null)}
                              type="button"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <span>
                            {loc}
                            <span className="settings-location-count">{itemCount} item{itemCount !== 1 ? "s" : ""}</span>
                          </span>
                        )}
                      </div>
                      <div className="settings-column-actions">
                        <div className="settings-action-wrap">
                          <button
                            className="settings-action-icon"
                            onClick={() => { setEditingLocationName(loc); setEditingLocationValue(loc); }}
                            disabled={savingLocation}
                            aria-label="Rename location"
                            type="button"
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M4 16.75V20h3.25l9.58-9.58-3.25-3.25L4 16.75Zm12.62-10.87 1.5-1.5a1 1 0 0 1 1.42 0l1.58 1.58a1 1 0 0 1 0 1.42l-1.5 1.5-3-3Z" />
                            </svg>
                          </button>
                          <span className="settings-action-tip" role="tooltip">Rename</span>
                        </div>
                        <div className="settings-action-wrap">
                          <button
                            className="settings-action-icon"
                            onClick={() => setPendingDeleteLocation((prev) => prev === loc ? null : loc)}
                            disabled={savingLocation}
                            aria-label="Remove location"
                            type="button"
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-1 6h2v9H8V9Zm4 0h2v9h-2V9Zm4 0h2v9h-2V9Z" />
                            </svg>
                          </button>
                          <span className="settings-action-tip" role="tooltip">Remove</span>
                          {pendingDeleteLocation === loc ? (
                            <div className="settings-delete-confirm" role="dialog" aria-label="Confirm remove">
                              {itemCount > 0 ? (
                                <p>{itemCount} item{itemCount !== 1 ? "s" : ""} will become unassigned.</p>
                              ) : (
                                <p>Remove this location?</p>
                              )}
                              <div className="settings-delete-confirm-actions">
                                <button
                                  className="button button-secondary settings-inline-action"
                                  onClick={() => setPendingDeleteLocation(null)}
                                  type="button"
                                >
                                  Cancel
                                </button>
                                <button
                                  className="button button-ghost settings-inline-action"
                                  onClick={() => void onRemoveLocation(loc)}
                                  disabled={savingLocation}
                                  type="button"
                                >
                                  Remove
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="settings-section-copy">
              Only administrators can manage locations.
            </p>
          )}
        </details>

        <details
          className="settings-section spacer-top"
          open={disclosures.inventoryColumns}
          onToggle={(event) => onDisclosureToggle("inventoryColumns", event.currentTarget.open)}
        >
          <summary className="settings-section-title">Inventory Columns</summary>
          {canManageInventoryColumns ? (
            <>
              <p className="settings-section-copy">
                Add or remove custom columns. *Required columns cannot be removed, but can be shown
                or hidden by clicking the checkbox.
              </p>
              <div className="settings-columns-toolbar">
                <div className="inventory-search-wrap settings-columns-toolbar-search">
                  <input
                    className="inventory-search-input"
                    placeholder="Search columns..."
                    value={inventoryColumnSearchTerm}
                    onChange={(event) => setInventoryColumnSearchTerm(event.target.value)}
                  />
                  {inventoryColumnSearchTerm ? (
                    <button
                      type="button"
                      className="inventory-search-clear"
                      onClick={() => setInventoryColumnSearchTerm("")}
                      aria-label="Clear column search"
                      title="Clear column search"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
                <div className="settings-columns-add settings-columns-add-inline">
                  <input
                    className="field"
                    placeholder="Column name"
                    value={newColumnName}
                    onChange={(event) => setNewColumnName(event.target.value)}
                  />
                  <button
                    className="button button-secondary"
                    onClick={onAddColumn}
                    disabled={savingColumn || !newColumnName.trim()}
                  >
                    Add Column
                  </button>
                </div>
              </div>
              <div className="settings-columns-list">
                {loadingColumns ? <div>Loading columns...</div> : null}
                {!loadingColumns && columns.length > 0 && filteredInventoryColumns.length === 0 ? (
                  <div>No matching columns.</div>
                ) : null}
                {filteredInventoryColumns.map((column) => (
                  (() => {
                    const isLocked = isLockedColumn(column);
                    return (
                  <div key={column.id} className="settings-column-row">
                    <div className="settings-column-visibility">
                      <input
                        type="checkbox"
                        checked={column.isVisible}
                        onChange={() => onToggleColumnVisibility(column)}
                        disabled={savingColumn}
                      />
                      {editingColumnId === column.id ? (
                        <span className="settings-column-edit">
                          <input
                            className="field settings-column-edit-input"
                            value={editingLabel}
                            onChange={(event) => setEditingLabel(event.target.value)}
                            disabled={savingColumn}
                          />
                          <button
                            className="button button-secondary settings-inline-action"
                            onClick={() => void onSaveEditColumn(column)}
                            disabled={savingColumn || !editingLabel.trim()}
                            type="button"
                          >
                            Save
                          </button>
                          <button
                            className="button button-ghost settings-inline-action"
                            onClick={onCancelEditColumn}
                            type="button"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <span>{column.label}</span>
                      )}
                    </div>
                    <div className="settings-column-actions">
                      {isLocked ? (
                        <span className="settings-core-pill">*Required</span>
                      ) : (
                        <div className="settings-action-wrap">
                          <button
                            className="settings-action-icon"
                            onClick={() => onStartEditColumn(column)}
                            disabled={savingColumn}
                            aria-label="Edit column"
                            type="button"
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M4 16.75V20h3.25l9.58-9.58-3.25-3.25L4 16.75Zm12.62-10.87 1.5-1.5a1 1 0 0 1 1.42 0l1.58 1.58a1 1 0 0 1 0 1.42l-1.5 1.5-3-3Z" />
                            </svg>
                          </button>
                          <span className="settings-action-tip" role="tooltip">Edit</span>
                        </div>
                      )}
                      {!isLocked ? (
                        <div className="settings-action-wrap">
                          <button
                            className="settings-action-icon"
                            onClick={() =>
                              setPendingDeleteColumnId((prev) =>
                                prev === column.id ? null : column.id,
                              )
                            }
                            disabled={savingColumn}
                            aria-label="Delete column"
                            type="button"
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-1 6h2v9H8V9Zm4 0h2v9h-2V9Zm4 0h2v9h-2V9Z" />
                            </svg>
                          </button>
                          <span className="settings-action-tip" role="tooltip">Delete</span>
                          {pendingDeleteColumnId === column.id ? (
                            <div className="settings-delete-confirm" role="dialog" aria-label="Confirm delete">
                              <p>Are you sure?</p>
                              <div className="settings-delete-confirm-actions">
                                <button
                                  className="button button-secondary settings-inline-action"
                                  onClick={() => setPendingDeleteColumnId(null)}
                                  type="button"
                                >
                                  Cancel
                                </button>
                                <button
                                  className="button button-ghost settings-inline-action"
                                  onClick={() => void onDeleteColumn(column.id)}
                                  disabled={savingColumn}
                                  type="button"
                                >
                                  OK
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                    );
                  })()
                ))}
              </div>
            </>
          ) : (
            <p className="settings-section-copy">
              Only administrators can manage inventory columns.
            </p>
          )}
        </details>
      </div>
    </section>
  );
}
