import { useEffect, useState } from "react";
import {
  confirmUserAttribute,
  fetchAuthSession,
  updateUserAttributes,
} from "aws-amplify/auth";
import {
  createBillingPortalSession,
  createInventoryColumn,
  deleteInventoryColumn,
  listModuleAccessUsers,
  loadInventoryBootstrap,
  type ModuleAccessUser,
  type AppModuleKey,
  syncCurrentUserEmail,
  updateOrgModules,
  updateUserModuleAccess,
  updateCurrentUserDisplayName,
  updateInventoryColumnLabel,
  updateInventoryColumnVisibility,
  type InventoryColumn,
} from "../lib/inventoryApi";
import { MODULE_REGISTRY } from "../lib/moduleRegistry";
import type { ThemePreference } from "../lib/themePreference";
import type { UsageFormPreferences } from "../lib/usageFormPreferences";

const SETTINGS_DISCLOSURES_STORAGE_KEY = "wickops.settings.disclosures";
type DisclosureKey = "appearance" | "orgModules" | "userModuleAccess" | "usageFormFields" | "inventoryColumns";
type DisclosureState = Record<DisclosureKey, boolean>;
const DEFAULT_DISCLOSURE_STATE: DisclosureState = {
  appearance: true,
  orgModules: true,
  userModuleAccess: true,
  usageFormFields: true,
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
  canManageOrgModules: boolean;
  orgAvailableModules: AppModuleKey[];
  orgEnabledModules: AppModuleKey[];
  onOrgEnabledModulesChange: (modules: AppModuleKey[]) => void;
  currentUserId: string;
  themePreference: ThemePreference;
  onThemePreferenceChange: (preference: ThemePreference) => void;
  usageFormPreferences: UsageFormPreferences;
  onUsageFormPreferencesChange: (preferences: UsageFormPreferences) => void;
  onCurrentUserAllowedModulesChange: (allowedModules: AppModuleKey[]) => void;
  onCurrentUserDisplayNameChange: (displayName: string) => void;
  onCurrentUserEmailChange: (email: string) => void;
  onInviteUsers: () => void;
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
  canManageOrgModules,
  orgAvailableModules,
  orgEnabledModules,
  onOrgEnabledModulesChange,
  currentUserId,
  themePreference,
  onThemePreferenceChange,
  usageFormPreferences,
  onUsageFormPreferencesChange,
  onCurrentUserAllowedModulesChange,
  onCurrentUserDisplayNameChange,
  onCurrentUserEmailChange,
  onInviteUsers,
}: SettingsPageProps) {
  const normalizeEmail = (value: string): string => value.trim().toLowerCase();
  const normalizeLooseKey = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nonEditableKeys = new Set(["itemName", "quantity", "minQuantity", "expirationDate"]);
  const isLockedColumn = (column: InventoryColumn): boolean =>
    column.isCore || column.isRequired || nonEditableKeys.has(column.key);
  const [columns, setColumns] = useState<InventoryColumn[]>([]);
  const [newColumnName, setNewColumnName] = useState("");
  const [usageFieldSearchTerm, setUsageFieldSearchTerm] = useState("");
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
  const [orgModulesError, setOrgModulesError] = useState<string | null>(null);
  const [orgModulesSaving, setOrgModulesSaving] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
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
        orgModules:
          typeof parsed.orgModules === "boolean"
            ? parsed.orgModules
            : DEFAULT_DISCLOSURE_STATE.orgModules,
        userModuleAccess:
          typeof parsed.userModuleAccess === "boolean"
            ? parsed.userModuleAccess
            : DEFAULT_DISCLOSURE_STATE.userModuleAccess,
        usageFormFields:
          typeof parsed.usageFormFields === "boolean"
            ? parsed.usageFormFields
            : DEFAULT_DISCLOSURE_STATE.usageFormFields,
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

  const hasLocationColumn = columns.some((column) => {
    const keyLoose = normalizeLooseKey(String(column.key ?? ""));
    const labelLoose = normalizeLooseKey(String(column.label ?? ""));
    return keyLoose === "location" || labelLoose === "location";
  });

  const hasNotesColumn = columns.some((column) => {
    const keyLoose = normalizeLooseKey(String(column.key ?? ""));
    const labelLoose = normalizeLooseKey(String(column.label ?? ""));
    return (
      keyLoose === "notes" ||
      keyLoose === "note" ||
      labelLoose === "notes" ||
      labelLoose === "note"
    );
  });

  const getColumnPreferenceKey = (column: InventoryColumn): string =>
    normalizeLooseKey(String(column.key || column.label || ""));

  const isUsageColumnEnabled = (column: InventoryColumn): boolean => {
    if (usageFormPreferences.mode === "all") return true;
    const prefKey = getColumnPreferenceKey(column);
    return usageFormPreferences.enabledColumnKeys.includes(prefKey);
  };

  const onToggleUsageColumn = (column: InventoryColumn, checked: boolean) => {
    if (!canManageInventoryColumns) return;
    const prefKey = getColumnPreferenceKey(column);
    const allPrefKeys = columns
      .map((item) => getColumnPreferenceKey(item))
      .filter((value) => value.length > 0);

    if (usageFormPreferences.mode === "all") {
      if (checked) return;
      onUsageFormPreferencesChange({
        mode: "custom",
        enabledColumnKeys: allPrefKeys.filter((value) => value !== prefKey),
      });
      return;
    }

    const next = new Set(usageFormPreferences.enabledColumnKeys);
    if (checked) {
      next.add(prefKey);
    } else {
      next.delete(prefKey);
    }
    onUsageFormPreferencesChange({
      mode: "custom",
      enabledColumnKeys: Array.from(next),
    });
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
    if (targetUserId === currentUserId && next.size === 0) {
      alert("You must keep access to at least one module.");
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

  const normalizedUsageFieldSearch = usageFieldSearchTerm.trim().toLowerCase();
  const filteredUsageColumns = columns.filter((column) => {
    if (!normalizedUsageFieldSearch) return true;
    const label = String(column.label ?? "").toLowerCase();
    const key = String(column.key ?? "").toLowerCase();
    return label.includes(normalizedUsageFieldSearch) || key.includes(normalizedUsageFieldSearch);
  });
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

        <div className="status-panel">
          {canInviteMore
            ? `You have ${seatsRemaining} invite${seatsRemaining === 1 ? "" : "s"} remaining (${seatsUsed}/${seatLimit} seats used).`
            : `No invite seats remaining (${seatsUsed}/${seatLimit} seats used).`}
        </div>

        {canManageOrgModules ? (
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

        {canManageOrgModules && orgAvailableModules.length > 0 ? (
          <details
            className="settings-section spacer-top"
            open={disclosures.orgModules}
            onToggle={(event) => onDisclosureToggle("orgModules", event.currentTarget.open)}
          >
            <summary className="settings-section-title">Organization Modules</summary>
            <p className="settings-section-copy">
              Enable or disable modules for all users in your organization.
            </p>
            {orgModulesError ? (
              <p className="settings-section-copy" style={{ color: "var(--color-danger, #c0392b)" }}>
                {orgModulesError}
              </p>
            ) : null}
            <div className="module-marketplace-grid">
              {MODULE_REGISTRY
                .filter((m) => m.status === "stable" && orgAvailableModules.includes(m.key))
                .map((m) => {
                  const enabled = orgEnabledModules.includes(m.key);
                  return (
                    <div
                      key={`org-module-${m.key}`}
                      className={`module-card${enabled ? " module-card-enabled" : ""}`}
                    >
                      <div className="module-card-header">
                        <span className="module-card-icon">{m.icon}</span>
                        <span className="module-card-name">{m.name}</span>
                      </div>
                      <p className="module-card-description">{m.description}</p>
                      <div className="module-card-footer">
                        <span className="module-card-category">{m.category}</span>
                        <label className="module-card-toggle">
                          <input
                            type="checkbox"
                            checked={enabled}
                            disabled={orgModulesSaving}
                            onChange={async () => {
                              const next = enabled
                                ? orgEnabledModules.filter((k) => k !== m.key)
                                : [...orgEnabledModules, m.key];
                              if (next.length === 0) {
                                setOrgModulesError("At least one module must remain enabled.");
                                return;
                              }
                              setOrgModulesError(null);
                              setOrgModulesSaving(true);
                              onOrgEnabledModulesChange(next);
                              try {
                                const saved = await updateOrgModules(next);
                                onOrgEnabledModulesChange(saved);
                              } catch (err: any) {
                                onOrgEnabledModulesChange(orgEnabledModules);
                                setOrgModulesError(err?.message ?? "Failed to save. Please try again.");
                              } finally {
                                setOrgModulesSaving(false);
                              }
                            }}
                          />
                          <span>{enabled ? "Enabled" : "Disabled"}</span>
                        </label>
                      </div>
                    </div>
                  );
                })}
            </div>
          </details>
        ) : null}

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
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="settings-section-copy">
              Only administrators can manage module access.
            </p>
          )}
        </details>

        <details
          className="settings-section spacer-top"
          open={disclosures.usageFormFields}
          onToggle={(event) => onDisclosureToggle("usageFormFields", event.currentTarget.open)}
        >
          <summary className="settings-section-title">Usage Form Fields</summary>
          <p className="settings-section-copy">
            Admins control which fields are allowed on the Usage Form.
          </p>
          <div className="inventory-search-wrap">
            <input
              className="inventory-search-input"
              placeholder="Search usage fields..."
              value={usageFieldSearchTerm}
              onChange={(event) => setUsageFieldSearchTerm(event.target.value)}
            />
            {usageFieldSearchTerm ? (
              <button
                type="button"
                className="inventory-search-clear"
                onClick={() => setUsageFieldSearchTerm("")}
                aria-label="Clear usage field search"
                title="Clear usage field search"
              >
                ×
              </button>
            ) : null}
          </div>
          <div className="settings-columns-list">
            {loadingColumns ? <div>Loading columns...</div> : null}
            {!loadingColumns && columns.length === 0 ? <div>No inventory columns found.</div> : null}
            {!loadingColumns && columns.length > 0 && filteredUsageColumns.length === 0 ? (
              <div>No matching usage fields.</div>
            ) : null}
            {filteredUsageColumns.map((column) => (
              <label className="settings-column-row" key={`usage-${column.id}`}>
                <span className="settings-column-visibility">
                  <input
                    type="checkbox"
                    checked={isUsageColumnEnabled(column)}
                    disabled={!canManageInventoryColumns}
                    onChange={(event) => onToggleUsageColumn(column, event.target.checked)}
                  />
                  <span>{column.label}</span>
                </span>
                {!column.isVisible ? <span className="settings-core-pill">Hidden in Inventory</span> : null}
              </label>
            ))}
            {!canManageInventoryColumns ? (
              <p className="settings-section-copy">
                Only administrators can change Usage Form field selections.
              </p>
            ) : null}
            {canManageInventoryColumns && !hasLocationColumn && !hasNotesColumn ? (
              <p className="settings-section-copy">
                Add a Location and/or Notes column to enable those optional Usage Form inputs.
              </p>
            ) : null}
          </div>
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
