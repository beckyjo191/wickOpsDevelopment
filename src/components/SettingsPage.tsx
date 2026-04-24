import { useEffect, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
  updateInventoryColumnType,
  reorderInventoryColumns,
  saveUserColumnVisibility,
  type ColumnVisibilityOverrides,
  type InventoryColumn,
  type InventoryRow,
  exportInventoryData,
} from "../lib/inventoryApi";
import { MODULE_BY_KEY } from "../lib/moduleRegistry";
import type { ThemePreference } from "../lib/themePreference";
import {
  cancelInvite,
  listPendingInvites,
  resendInvite,
  type PendingInvite,
} from "../lib/invitesApi";
import { GripVertical, Pencil, Trash2 } from "lucide-react";

const SETTINGS_DISCLOSURES_STORAGE_KEY = "wickops.settings.disclosures";
type DisclosureKey = "appearance" | "userModuleAccess" | "pendingInvites" | "locations" | "inventoryColumns" | "importData" | "exportData" | "help";
type DisclosureState = Record<DisclosureKey, boolean>;
const DEFAULT_DISCLOSURE_STATE: DisclosureState = {
  appearance: true,
  userModuleAccess: true,
  pendingInvites: true,
  locations: true,
  inventoryColumns: false,
  importData: false,
  exportData: false,
  help: false,
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
  onNavigateToImport: (action: "import-csv" | "paste-import" | "download-template") => void;
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
  onNavigateToImport,
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
  const [reorderingColumns, setReorderingColumns] = useState(false);
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
  const [moduleAccessKeys, setModuleAccessKeys] = useState<AppModuleKey[]>(["inventory"]);
  const [loadingModuleAccess, setLoadingModuleAccess] = useState(false);
  const [savingModuleAccessUserId, setSavingModuleAccessUserId] = useState<string | null>(null);
  const [revokingUserId, setRevokingUserId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string>("");
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [loadingPendingInvites, setLoadingPendingInvites] = useState(false);
  const [pendingInvitesError, setPendingInvitesError] = useState<string>("");
  const [resendingInviteEmail, setResendingInviteEmail] = useState<string | null>(null);
  const [cancellingInviteEmail, setCancellingInviteEmail] = useState<string | null>(null);
  const [pendingCancelInviteEmail, setPendingCancelInviteEmail] = useState<string | null>(null);
  const [inviteActionStatus, setInviteActionStatus] = useState<string>("");
  const [portalLoading, setPortalLoading] = useState(false);
  const [exportStatus, setExportStatus] = useState<"idle" | "exporting" | "done" | "error">("idle");
  const [registeredLocations, setRegisteredLocations] = useState<string[]>([]);
  const [inventoryRows, setInventoryRows] = useState<InventoryRow[]>([]);
  const [newLocationName, setNewLocationName] = useState("");
  const [savingLocation, setSavingLocation] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [editingLocationName, setEditingLocationName] = useState<string | null>(null);
  const [editingLocationValue, setEditingLocationValue] = useState("");
  const [renameLocationError, setRenameLocationError] = useState<string | null>(null);
  const [pendingDeleteLocation, setPendingDeleteLocation] = useState<string | null>(null);
  const [userColumnOverrides, setUserColumnOverrides] = useState<ColumnVisibilityOverrides>({});
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
          setUserColumnOverrides(bootstrap.columnVisibilityOverrides ?? {});
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
          setModuleAccessKeys(data.modules.length > 0 ? data.modules : ["inventory"]);
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
    if (!canManageModuleAccess) return;
    let cancelled = false;

    const load = async () => {
      setLoadingPendingInvites(true);
      setPendingInvitesError("");
      try {
        const invites = await listPendingInvites();
        if (!cancelled) setPendingInvites(invites);
      } catch (err: any) {
        if (!cancelled) {
          setPendingInvitesError(err?.message ?? "Failed to load pending invites");
        }
      } finally {
        if (!cancelled) setLoadingPendingInvites(false);
      }
    };

    void load();
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
        pendingInvites:
          typeof parsed.pendingInvites === "boolean"
            ? parsed.pendingInvites
            : DEFAULT_DISCLOSURE_STATE.pendingInvites,
        locations:
          typeof parsed.locations === "boolean"
            ? parsed.locations
            : DEFAULT_DISCLOSURE_STATE.locations,
        inventoryColumns:
          typeof parsed.inventoryColumns === "boolean"
            ? parsed.inventoryColumns
            : DEFAULT_DISCLOSURE_STATE.inventoryColumns,
        importData:
          typeof parsed.importData === "boolean"
            ? parsed.importData
            : DEFAULT_DISCLOSURE_STATE.importData,
        exportData:
          typeof parsed.exportData === "boolean"
            ? parsed.exportData
            : DEFAULT_DISCLOSURE_STATE.exportData,
        help:
          typeof parsed.help === "boolean"
            ? parsed.help
            : DEFAULT_DISCLOSURE_STATE.help,
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
    // Client-side case-insensitive duplicate check
    const duplicate = allLocations.find((l) => l.toLowerCase() === name.toLowerCase());
    if (duplicate) {
      setLocationError(`"${duplicate}" already exists`);
      return;
    }
    setLocationError(null);
    setSavingLocation(true);
    try {
      const locs = await addInventoryLocation(name);
      setRegisteredLocations(locs);
      setNewLocationName("");
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.includes("already exists")) {
        setLocationError(msg);
      } else {
        console.error(err);
      }
    } finally {
      setSavingLocation(false);
    }
  };

  const onRenameLocation = async (oldName: string) => {
    const newName = editingLocationValue.trim();
    if (!newName || newName === oldName) {
      setEditingLocationName(null);
      setRenameLocationError(null);
      return;
    }
    // Client-side case-insensitive duplicate check (ignore the one being renamed)
    const duplicate = allLocations.find(
      (l) => l !== oldName && l.toLowerCase() === newName.toLowerCase(),
    );
    if (duplicate) {
      setRenameLocationError(`"${duplicate}" already exists`);
      return;
    }
    setRenameLocationError(null);
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
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.includes("already exists")) {
        setRenameLocationError(msg);
      } else {
        console.error(err);
      }
    } finally {
      setSavingLocation(false);
    }
  };

  const onRemoveLocation = async (name: string) => {
    setSavingLocation(true);
    try {
      const locs = await removeInventoryLocation(name);
      setRegisteredLocations(locs);
      setInventoryRows((prev) =>
        prev.filter((r) => String(r.values.location ?? "").trim() !== name),
      );
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
    const currentlyVisible = userColumnOverrides[column.id] !== undefined
      ? userColumnOverrides[column.id]
      : column.isVisible;
    // Prevent hiding all columns
    const visibleCount = columns.filter((c) => {
      const ov = userColumnOverrides[c.id];
      return ov !== undefined ? ov : c.isVisible;
    }).length;
    if (currentlyVisible && visibleCount <= 1) return;

    const newOverrides = { ...userColumnOverrides, [column.id]: !currentlyVisible };
    setSavingColumn(true);
    setUserColumnOverrides(newOverrides);
    try {
      await saveUserColumnVisibility(newOverrides);
    } catch (err: any) {
      setUserColumnOverrides(userColumnOverrides);
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

  const onChangeColumnType = async (column: InventoryColumn, newType: InventoryColumn["type"]) => {
    if (!canManageInventoryColumns || column.isCore || column.type === newType) return;
    setSavingColumn(true);
    try {
      await updateInventoryColumnType(column.id, newType);
      setColumns((prev) =>
        prev.map((item) =>
          item.id === column.id ? { ...item, type: newType } : item,
        ),
      );
    } catch (err: any) {
      alert(err?.message ?? "Failed to update column type");
    } finally {
      setSavingColumn(false);
    }
  };

  const onColumnDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!canManageInventoryColumns || reorderingColumns) return;
    if (!over || active.id === over.id) return;
    const fromIndex = columns.findIndex((c) => c.id === active.id);
    const toIndex = columns.findIndex((c) => c.id === over.id);
    if (fromIndex < 0 || toIndex < 0) return;

    const newColumns = arrayMove(columns, fromIndex, toIndex).map((col, i) => ({
      ...col,
      sortOrder: (i + 1) * 10,
    }));
    setColumns(newColumns);

    setReorderingColumns(true);
    try {
      await reorderInventoryColumns(newColumns.map((c) => c.id));
    } catch (err) {
      console.error("Failed to reorder columns:", err);
      const bootstrap = await loadInventoryBootstrap();
      setColumns([...bootstrap.columns].sort((a, b) => a.sortOrder - b.sortOrder));
    } finally {
      setReorderingColumns(false);
    }
  };

  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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

  const onResendInvite = async (email: string) => {
    setResendingInviteEmail(email);
    setInviteActionStatus("");
    setPendingInvitesError("");
    try {
      await resendInvite(email);
      // Refresh list so the updated expiresAt shows up
      const refreshed = await listPendingInvites();
      setPendingInvites(refreshed);
      setInviteActionStatus(`Invite email resent to ${email}.`);
    } catch (err: any) {
      setPendingInvitesError(err?.message ?? "Failed to resend invite");
    } finally {
      setResendingInviteEmail(null);
    }
  };

  const onCancelInvite = async (email: string) => {
    setCancellingInviteEmail(email);
    setInviteActionStatus("");
    setPendingInvitesError("");
    try {
      await cancelInvite(email);
      setPendingInvites((prev) => prev.filter((inv) => inv.email !== email));
      setInviteActionStatus(`Invite for ${email} cancelled.`);
      setPendingCancelInviteEmail(null);
    } catch (err: any) {
      setPendingInvitesError(err?.message ?? "Failed to cancel invite");
    } finally {
      setCancellingInviteEmail(null);
    }
  };

  const formatInviteDate = (iso: string): string => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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

  const onExportData = async () => {
    setExportStatus("exporting");
    try {
      await exportInventoryData();
      setExportStatus("done");
    } catch {
      setExportStatus("error");
    }
  };

  const onDisclosureToggle = (key: DisclosureKey, isOpen: boolean) => {
    if (loadedDisclosureKey !== disclosureStorageKey) return;
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
      <div className="settings-page">
        <div className="settings-page-header">
          <h2 className="dash-title">Settings</h2>
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
        </div>

        <div className="settings-account-bar">
          <span className="settings-account-seats">
            {seatsUsed}/{seatLimit} seats used
            {seatsRemaining > 0 ? ` \u00b7 ${seatsRemaining} remaining` : ""}
          </span>
          <div className="settings-account-actions">
            <button
              className="button button-secondary button-sm"
              onClick={onInviteUsers}
              disabled={!canInviteMore}
            >
              Invite Users
            </button>
            {canManageModuleAccess ? (
              <button
                className="button button-secondary button-sm"
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
                {portalLoading ? "Opening…" : "Billing"}
              </button>
            ) : null}
          </div>
        </div>

        <details className="settings-section" open>
          <summary className="settings-section-title">Profile</summary>
          <div className="settings-field-group">
            <label className="settings-field-label">Display Name</label>
            <div className="settings-field-row">
              <input
                className={`field settings-profile-field${!editingDisplayName ? " settings-profile-field-locked" : ""}`}
                type="text"
                placeholder="Your name"
                value={displayNameInput}
                onChange={(event) => setDisplayNameInput(event.target.value)}
                disabled={!editingDisplayName || savingDisplayName}
              />
              {!editingDisplayName ? (
                <button
                  className="button button-ghost button-sm"
                  onClick={() => setEditingDisplayName(true)}
                  type="button"
                >
                  Edit
                </button>
              ) : (
                <>
                  <button
                    className="button button-secondary button-sm"
                    type="button"
                    onClick={() => void onSaveDisplayName()}
                    disabled={savingDisplayName || !displayNameInput.trim()}
                  >
                    {savingDisplayName ? "Saving..." : "Save"}
                  </button>
                  <button
                    className="button button-ghost button-sm"
                    type="button"
                    onClick={onCancelDisplayNameEdit}
                    disabled={savingDisplayName}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="settings-field-group">
            <label className="settings-field-label">Email</label>
            <div className="settings-field-row">
              <input
                className={`field settings-profile-field${!editingEmail ? " settings-profile-field-locked" : ""}`}
                type="email"
                placeholder="your@email.com"
                value={emailInput}
                onChange={(event) => setEmailInput(event.target.value)}
                disabled={!editingEmail || savingEmail || verifyingEmail}
              />
              {!editingEmail ? (
                <button
                  className="button button-ghost button-sm"
                  onClick={onStartEmailEdit}
                  type="button"
                >
                  Edit
                </button>
              ) : (
                <>
                  <button
                    className="button button-secondary button-sm"
                    type="button"
                    onClick={() => void onSendEmailVerification()}
                    disabled={savingEmail || verifyingEmail || !normalizeEmail(emailInput)}
                  >
                    {savingEmail ? "Sending..." : "Verify"}
                  </button>
                  <button
                    className="button button-ghost button-sm"
                    type="button"
                    onClick={onCancelEmailEdit}
                    disabled={savingEmail || verifyingEmail}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
            {editingEmail && pendingEmailVerification ? (
              <div className="settings-field-row" style={{ marginTop: "0.5rem" }}>
                <input
                  className="field settings-profile-field"
                  type="text"
                  placeholder="Verification code"
                  value={emailVerificationCode}
                  onChange={(event) => setEmailVerificationCode(event.target.value)}
                  disabled={verifyingEmail}
                />
                <button
                  className="button button-secondary button-sm"
                  type="button"
                  onClick={() => void onConfirmEmailVerification()}
                  disabled={verifyingEmail || !emailVerificationCode.trim()}
                >
                  {verifyingEmail ? "Confirming..." : "Confirm"}
                </button>
              </div>
            ) : null}
          </div>
        </details>

        <details
          className="settings-section"
          open={disclosures.appearance}
          onToggle={(event) => onDisclosureToggle("appearance", event.currentTarget.open)}
        >
          <summary className="settings-section-title">Appearance</summary>
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

        {canManageInventoryColumns && (
          <details
            className="settings-section"
            open={disclosures.importData}
            onToggle={(event) => onDisclosureToggle("importData", event.currentTarget.open)}
          >
            <summary className="settings-section-title">Import Data</summary>
            <p className="settings-section-copy">
              Import inventory items from a spreadsheet or paste data directly.
            </p>
            <div className="settings-import-actions">
              <button
                type="button"
                className="button button-secondary button-sm"
                onClick={() => onNavigateToImport("import-csv")}
              >
                Upload CSV / XLSX
              </button>
              <button
                type="button"
                className="button button-secondary button-sm"
                onClick={() => onNavigateToImport("paste-import")}
              >
                Paste Data
              </button>
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => onNavigateToImport("download-template")}
              >
                Download Template
              </button>
            </div>
          </details>
        )}

        {canManageInventoryColumns && (
          <details
            className="settings-section"
            open={disclosures.exportData}
            onToggle={(event) => onDisclosureToggle("exportData", event.currentTarget.open)}
          >
            <summary className="settings-section-title">Export Data</summary>
            <p className="settings-section-copy">
              Download all inventory data as a spreadsheet. Includes all items, columns, and locations.
            </p>
            <div className="settings-import-actions">
              <button
                type="button"
                className="button button-primary button-sm"
                onClick={() => void onExportData()}
                disabled={exportStatus === "exporting"}
              >
                {exportStatus === "exporting" ? "Exporting..." : "Export Inventory Data"}
              </button>
            </div>
            {exportStatus === "done" && (
              <p className="settings-export-status settings-export-success">Export complete — check your downloads folder.</p>
            )}
            {exportStatus === "error" && (
              <p className="settings-export-status settings-export-error">Export failed. Please try again.</p>
            )}
          </details>
        )}

        <details
          className="settings-section"
          open={disclosures.userModuleAccess}
          onToggle={(event) => onDisclosureToggle("userModuleAccess", event.currentTarget.open)}
        >
          <summary className="settings-section-title">Team Access</summary>
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
                    {moduleAccessKeys.length > 1 && moduleAccessKeys.map((moduleKey) => {
                      const normalizedCurrentEmail = normalizeEmail(currentUserEmail);
                      const normalizedUserEmail = normalizeEmail(user.email);
                      const normalizedUserIdAsEmail = normalizeEmail(user.userId);
                      const isSelf =
                        user.userId === currentUserId ||
                        (!!normalizedCurrentEmail &&
                          (normalizedUserEmail === normalizedCurrentEmail ||
                            normalizedUserIdAsEmail === normalizedCurrentEmail));
                      const isChecked = user.allowedModules.includes(moduleKey);
                      const moduleLabel = MODULE_BY_KEY[moduleKey]?.name ?? moduleKey;
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
                        <span>{moduleLabel}</span>
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

        {canManageModuleAccess ? (
          <details
            className="settings-section"
            open={disclosures.pendingInvites}
            onToggle={(event) => onDisclosureToggle("pendingInvites", event.currentTarget.open)}
          >
            <summary className="settings-section-title">
              Pending Invites
              {pendingInvites.length > 0 ? ` (${pendingInvites.length})` : ""}
            </summary>
            <p className="settings-section-copy">
              People you've invited who haven't signed in yet. Invites expire 14 days after sending.
              Resend to send a fresh email; cancel to free the seat.
            </p>
            <div className="settings-columns-list">
              {loadingPendingInvites ? <div>Loading pending invites...</div> : null}
              {!loadingPendingInvites && pendingInvites.length === 0 ? (
                <div className="settings-section-copy">No pending invites.</div>
              ) : null}
              {pendingInvites.map((invite) => {
                const expiresAt = invite.expiresAt ? new Date(invite.expiresAt) : null;
                const isExpired = expiresAt ? expiresAt.getTime() < Date.now() : false;
                return (
                  <div className="settings-column-row" key={`pending-invite-${invite.email}`}>
                    <div className="settings-column-visibility">
                      <span>
                        {invite.displayName?.trim() || invite.email}
                        {invite.displayName?.trim() ? (
                          <span className="settings-location-count">{invite.email}</span>
                        ) : null}
                      </span>
                      <span className="settings-core-pill">{invite.role}</span>
                      {isExpired ? (
                        <span className="settings-core-pill">Expired</span>
                      ) : expiresAt ? (
                        <span className="settings-location-count">
                          Expires {formatInviteDate(invite.expiresAt)}
                        </span>
                      ) : null}
                    </div>
                    <div className="settings-column-actions">
                      <button
                        type="button"
                        className="button button-secondary button-sm"
                        disabled={
                          resendingInviteEmail === invite.email ||
                          cancellingInviteEmail === invite.email
                        }
                        onClick={() => { void onResendInvite(invite.email); }}
                      >
                        {resendingInviteEmail === invite.email ? "Resending…" : "Resend"}
                      </button>
                      <button
                        type="button"
                        className="button button-ghost button-sm"
                        disabled={
                          resendingInviteEmail === invite.email ||
                          cancellingInviteEmail === invite.email
                        }
                        onClick={() => setPendingCancelInviteEmail(invite.email)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              })}
              {inviteActionStatus ? (
                <p className="settings-section-copy">{inviteActionStatus}</p>
              ) : null}
              {pendingInvitesError ? (
                <p className="settings-error">{pendingInvitesError}</p>
              ) : null}
            </div>
            {pendingCancelInviteEmail ? (() => {
              const email = pendingCancelInviteEmail;
              return (
                <div className="settings-destructive-overlay">
                  <div
                    className="settings-destructive-backdrop"
                    onClick={() => setPendingCancelInviteEmail(null)}
                  />
                  <div
                    className="settings-destructive-sheet"
                    role="dialog"
                    aria-label="Confirm cancel invite"
                  >
                    <div className="settings-destructive-sheet-body">
                      <p className="settings-destructive-sheet-title">Cancel Invite</p>
                      <p className="settings-destructive-sheet-msg">
                        Cancel the invite for {email}? Their seat will be freed and the email
                        link will stop working.
                      </p>
                    </div>
                    <div className="settings-destructive-sheet-actions">
                      <button type="button" onClick={() => setPendingCancelInviteEmail(null)}>
                        Keep Invite
                      </button>
                      <button
                        type="button"
                        disabled={cancellingInviteEmail === email}
                        onClick={() => { void onCancelInvite(email); }}
                      >
                        {cancellingInviteEmail === email ? "Cancelling…" : "Cancel Invite"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })() : null}
          </details>
        ) : null}

        <details
          className="settings-section"
          open={disclosures.locations}
          onToggle={(event) => onDisclosureToggle("locations", event.currentTarget.open)}
        >
          <summary className="settings-section-title">Locations</summary>
          {canManageInventoryColumns ? (
            <>
              <div className="settings-field-row" style={{ marginBottom: locationError ? "0.25rem" : "0.5rem" }}>
                <input
                  className={`field${locationError ? " field--error" : ""}`}
                  placeholder="New location name"
                  value={newLocationName}
                  onChange={(e) => { setNewLocationName(e.target.value); setLocationError(null); }}
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
              {locationError ? (
                <p className="settings-field-error">{locationError}</p>
              ) : null}
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
                              className={`field settings-column-edit-input${renameLocationError ? " field--error" : ""}`}
                              value={editingLocationValue}
                              onChange={(e) => { setEditingLocationValue(e.target.value); setRenameLocationError(null); }}
                              onKeyDown={(e) => { if (e.key === "Enter") void onRenameLocation(loc); if (e.key === "Escape") { setEditingLocationName(null); setRenameLocationError(null); } }}
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
                              onClick={() => { setEditingLocationName(null); setRenameLocationError(null); }}
                              type="button"
                            >
                              Cancel
                            </button>
                            {renameLocationError ? (
                              <span className="settings-field-error" style={{ width: "100%" }}>{renameLocationError}</span>
                            ) : null}
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
                            <Pencil aria-hidden="true" />
                          </button>
                          <span className="settings-action-tip" role="tooltip">Rename</span>
                        </div>
                        <div className="settings-action-wrap">
                          <button
                            className="settings-action-icon settings-action-icon--danger"
                            onClick={() => setPendingDeleteLocation((prev) => prev === loc ? null : loc)}
                            disabled={savingLocation}
                            aria-label="Remove location"
                            type="button"
                          >
                            <Trash2 aria-hidden="true" />
                          </button>
                          <span className="settings-action-tip" role="tooltip">Remove</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {pendingDeleteLocation ? (() => {
                const locName = pendingDeleteLocation;
                const deleteLocItemCount = getItemCountForLocation(locName);
                return (
                  <div className="settings-destructive-overlay">
                    <div className="settings-destructive-backdrop" onClick={() => setPendingDeleteLocation(null)} />
                    <div className="settings-destructive-sheet" role="dialog" aria-label="Confirm remove">
                      <div className="settings-destructive-sheet-body">
                        <p className="settings-destructive-sheet-title">Remove Location</p>
                        <p className="settings-destructive-sheet-msg">
                          {deleteLocItemCount > 0
                            ? `"${locName}" has ${deleteLocItemCount} item${deleteLocItemCount !== 1 ? "s" : ""} that will become unassigned.`
                            : `Remove "${locName}"?`}
                        </p>
                      </div>
                      <div className="settings-destructive-sheet-actions">
                        <button type="button" onClick={() => setPendingDeleteLocation(null)}>Cancel</button>
                        <button
                          type="button"
                          disabled={savingLocation}
                          onClick={() => { void onRemoveLocation(locName); }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })() : null}
            </>
          ) : (
            <p className="settings-section-copy">
              Only administrators can manage locations.
            </p>
          )}
        </details>

        <details
          className="settings-section"
          open={disclosures.inventoryColumns}
          onToggle={(event) => onDisclosureToggle("inventoryColumns", event.currentTarget.open)}
        >
          <summary className="settings-section-title">Columns</summary>
          {canManageInventoryColumns ? (
            <>
              <p className="settings-section-copy">
                Drag the handle to reorder columns. Show or hide columns with the checkbox. Core columns (Item Name, Quantity, Min Quantity, Expiration Date, Reorder Link) are required and cannot be deleted.
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
                <DndContext
                  sensors={dragSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={(event) => { void onColumnDragEnd(event); }}
                >
                  <SortableContext
                    items={filteredInventoryColumns.map((c) => c.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {filteredInventoryColumns.map((column) => {
                      const isSearching = normalizedInventoryColumnSearch.length > 0;
                      const dragDisabled = savingColumn || reorderingColumns || isSearching;
                      return (
                        <SortableColumnRow
                          key={column.id}
                          column={column}
                          isLocked={isLockedColumn(column)}
                          dragDisabled={dragDisabled}
                          savingColumn={savingColumn}
                          userColumnOverrides={userColumnOverrides}
                          editingColumnId={editingColumnId}
                          editingLabel={editingLabel}
                          setEditingLabel={setEditingLabel}
                          onToggleColumnVisibility={onToggleColumnVisibility}
                          onSaveEditColumn={onSaveEditColumn}
                          onCancelEditColumn={onCancelEditColumn}
                          onStartEditColumn={onStartEditColumn}
                          onChangeColumnType={onChangeColumnType}
                          setPendingDeleteColumnId={setPendingDeleteColumnId}
                        />
                      );
                    })}
                  </SortableContext>
                </DndContext>
              </div>
              {pendingDeleteColumnId ? (() => {
                const colId = pendingDeleteColumnId;
                const colToDelete = columns.find((c) => c.id === colId);
                return (
                  <div className="settings-destructive-overlay">
                    <div className="settings-destructive-backdrop" onClick={() => setPendingDeleteColumnId(null)} />
                    <div className="settings-destructive-sheet" role="dialog" aria-label="Confirm delete">
                      <div className="settings-destructive-sheet-body">
                        <p className="settings-destructive-sheet-title">Delete Column</p>
                        <p className="settings-destructive-sheet-msg">
                          {colToDelete ? `Delete "${colToDelete.label}"? This cannot be undone.` : "Delete this column? This cannot be undone."}
                        </p>
                      </div>
                      <div className="settings-destructive-sheet-actions">
                        <button type="button" onClick={() => setPendingDeleteColumnId(null)}>Cancel</button>
                        <button
                          type="button"
                          disabled={savingColumn}
                          onClick={() => { void onDeleteColumn(colId); }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })() : null}
            </>
          ) : (
            <p className="settings-section-copy">
              Only administrators can manage inventory columns.
            </p>
          )}
        </details>

        <details
          className="settings-section"
          open={disclosures.help}
          onToggle={(event) => onDisclosureToggle("help", event.currentTarget.open)}
        >
          <summary className="settings-section-title">Help</summary>
          <p className="settings-section-copy">Color guide used throughout the app.</p>
          <div className="settings-legend">
            <div className="settings-legend-item">
              <span className="settings-legend-dot" style={{ background: "var(--danger)" }} />
              <span>Expired</span>
            </div>
            <div className="settings-legend-item">
              <span className="settings-legend-dot" style={{ background: "var(--caution)" }} />
              <span>Expiring within 30 days</span>
            </div>
            <div className="settings-legend-item">
              <span className="settings-legend-dot" style={{ background: "var(--notice)" }} />
              <span>Expiring within 60 days</span>
            </div>
            <div className="settings-legend-item">
              <span className="settings-legend-dot" style={{ background: "var(--warning)" }} />
              <span>Low stock</span>
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}

interface SortableColumnRowProps {
  column: InventoryColumn;
  isLocked: boolean;
  dragDisabled: boolean;
  savingColumn: boolean;
  userColumnOverrides: ColumnVisibilityOverrides;
  editingColumnId: string | null;
  editingLabel: string;
  setEditingLabel: (value: string) => void;
  onToggleColumnVisibility: (column: InventoryColumn) => void;
  onSaveEditColumn: (column: InventoryColumn) => Promise<void> | void;
  onCancelEditColumn: () => void;
  onStartEditColumn: (column: InventoryColumn) => void;
  onChangeColumnType: (column: InventoryColumn, type: InventoryColumn["type"]) => Promise<void> | void;
  setPendingDeleteColumnId: Dispatch<SetStateAction<string | null>>;
}

function SortableColumnRow({
  column,
  isLocked,
  dragDisabled,
  savingColumn,
  userColumnOverrides,
  editingColumnId,
  editingLabel,
  setEditingLabel,
  onToggleColumnVisibility,
  onSaveEditColumn,
  onCancelEditColumn,
  onStartEditColumn,
  onChangeColumnType,
  setPendingDeleteColumnId,
}: SortableColumnRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
    disabled: dragDisabled,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    zIndex: isDragging ? 2 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`settings-column-row${isDragging ? " settings-column-row--dragging" : ""}`}
    >
      <div className="settings-column-top">
        <button
          type="button"
          className="settings-column-drag-handle"
          aria-label="Drag to reorder"
          disabled={dragDisabled}
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden="true" />
        </button>
        <div className="settings-column-visibility">
          <input
            type="checkbox"
            checked={userColumnOverrides[column.id] !== undefined ? userColumnOverrides[column.id] : column.isVisible}
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
      </div>
      <div className="settings-column-bottom">
        {isLocked ? (
          <span className="settings-core-pill">*Required</span>
        ) : (
          <>
            <select
              className="settings-column-type-select"
              value={column.type}
              onChange={(e) => {
                void onChangeColumnType(column, e.target.value as InventoryColumn["type"]);
              }}
              disabled={savingColumn}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="date">Date</option>
              <option value="link">Link</option>
              <option value="boolean">Yes/No</option>
            </select>
            <div className="settings-column-actions">
              <div className="settings-action-wrap">
                <button
                  className="settings-action-icon"
                  onClick={() => onStartEditColumn(column)}
                  disabled={savingColumn}
                  aria-label="Edit column"
                  type="button"
                >
                  <Pencil aria-hidden="true" />
                </button>
                <span className="settings-action-tip" role="tooltip">Edit</span>
              </div>
              <div className="settings-action-wrap">
                <button
                  className="settings-action-icon settings-action-icon--danger"
                  onClick={() =>
                    setPendingDeleteColumnId((prev) =>
                      prev === column.id ? null : column.id,
                    )
                  }
                  disabled={savingColumn}
                  aria-label="Delete column"
                  type="button"
                >
                  <Trash2 aria-hidden="true" />
                </button>
                <span className="settings-action-tip" role="tooltip">Delete</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
