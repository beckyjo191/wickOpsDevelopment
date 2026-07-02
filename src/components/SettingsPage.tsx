import { Fragment, useEffect, useMemo, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
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
  addInventoryVendor,
  createBillingPortalSession,
  createInventoryColumn,
  deleteInventoryColumn,
  listModuleAccessUsers,
  loadInventoryBootstrap,
  type ModuleAccessUser,
  type AppModuleKey,
  removeInventoryLocation,
  removeInventoryVendor,
  renameInventoryLocation,
  reorderInventoryLocations,
  moveInventoryItems,
  setInventoryLocationParent,
  renameInventoryVendor,
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
  type InventoryLocation,
  type InventoryRow,
  isLocationNotEmptyError,
  exportInventoryData,
  updateInventoryColumnAttachments,
} from "../lib/inventoryApi";
import { MODULE_BY_KEY } from "../lib/moduleRegistry";
import type { ThemePreference } from "../lib/themePreference";
import {
  cancelInvite,
  listPendingInvites,
  resendInvite,
  type PendingInvite,
} from "../lib/invitesApi";
import { AlertTriangle, ChevronRight, GripVertical, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useToast } from "./shared/Toast";
import { ConfirmDialog } from "./shared/ConfirmDialog";
import { AddNameDialog } from "./shared/AddNameDialog";
import { LocationPickerDialog } from "./inventory/LocationPickerDialog";
import { buildLocationTree, buildLocationPickerEntries, locationsInScope } from "../lib/locationTree";
import { isExpired } from "../lib/expiration";
import { CustomDropdown } from "./shared/CustomDropdown";
import { AddColumnDialog } from "./inventory/AddColumnDialog";
import { SupportAccessCard } from "./SupportAccessCard";

const SETTINGS_DISCLOSURES_STORAGE_KEY = "wickops.settings.disclosures";
type DisclosureKey = "appearance" | "userModuleAccess" | "pendingInvites" | "locations" | "vendors" | "allowedUnits" | "inventoryColumns" | "importData" | "exportData" | "helpSupport";
type DisclosureState = Record<DisclosureKey, boolean>;
const DEFAULT_DISCLOSURE_STATE: DisclosureState = {
  appearance: true,
  userModuleAccess: true,
  pendingInvites: true,
  locations: true,
  vendors: true,
  allowedUnits: false,
  inventoryColumns: false,
  importData: false,
  exportData: false,
  helpSupport: false,
};

const SUPPORT_EMAIL = "support@wickops.com";

interface SettingsPageProps {
  currentDisplayName: string;
  currentUserEmail: string;
  canInviteMore: boolean;
  seatsRemaining: number;
  seatLimit: number;
  seatsUsed: number;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: number | null;
  canManageInventoryColumns: boolean;
  canManageModuleAccess: boolean;
  /** True only for the org OWNER. Gates the support-access consent card. */
  isOrgOwner: boolean;
  /** Read-only WickOps support operator viewing a customer org. Reveals config
   *  lists (locations/vendors/columns) read-only in place of the admin-only
   *  placeholders, with no management controls. */
  isSupportView?: boolean;
  currentUserId: string;
  /** Org identity — embedded into support-contact emails so tickets
   *  self-identify which org to look up in the support console. */
  organizationId: string;
  orgName: string;
  themePreference: ThemePreference;
  onThemePreferenceChange: (preference: ThemePreference) => void;
  onCurrentUserAllowedModulesChange: (allowedModules: AppModuleKey[]) => void;
  onCurrentUserDisplayNameChange: (displayName: string) => void;
  onCurrentUserEmailChange: (email: string) => void;
  onUserRevoked: (userId: string, newSeatsUsed: number) => void;
  onInviteUsers: () => void;
  /** @deprecated Import was moved to the Inventory toolbar. Kept on the
   *  prop type so App.tsx doesn't need a coordinated change in this commit. */
  onNavigateToImport?: (action: "import-csv" | "paste-import" | "download-template") => void;
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
  cancelAtPeriodEnd,
  currentPeriodEnd,
  canManageInventoryColumns,
  canManageModuleAccess,
  isOrgOwner,
  isSupportView = false,
  currentUserId,
  organizationId,
  orgName,
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
  const toast = useToast();
  const normalizeEmail = (value: string): string => value.trim().toLowerCase();
  const nonEditableKeys = new Set(["itemName", "quantity", "minQuantity", "expirationDate"]);
  const isLockedColumn = (column: InventoryColumn): boolean =>
    column.isCore || column.isRequired || nonEditableKeys.has(column.key);
  const [columns, setColumns] = useState<InventoryColumn[]>([]);
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
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [inventoryRows, setInventoryRows] = useState<InventoryRow[]>([]);
  const [locationSearchTerm, setLocationSearchTerm] = useState("");
  const [showLocationAdd, setShowLocationAdd] = useState(false);
  const [savingLocation, setSavingLocation] = useState(false);
  const [reorderingLocations, setReorderingLocations] = useState(false);
  /** Primary whose "Add sublocation" inline input is open (null = none). */
  const [subParentId, setSubParentId] = useState<string | null>(null);
  const [newSubName, setNewSubName] = useState("");
  const [subError, setSubError] = useState<string | null>(null);
  /** Location whose "Move all contents" dialog is open (null = closed). */
  const [moveContentsSource, setMoveContentsSource] = useState<InventoryLocation | null>(null);
  const [moveContentsDestId, setMoveContentsDestId] = useState("");
  const [movingContents, setMovingContents] = useState(false);
  const [moveContentsError, setMoveContentsError] = useState<string | null>(null);
  /** Currently-edited location id (rename inline). Null when not editing. */
  const [editingLocationId, setEditingLocationId] = useState<string | null>(null);
  const [editingLocationValue, setEditingLocationValue] = useState("");
  const [renameLocationError, setRenameLocationError] = useState<string | null>(null);
  const [pendingDeleteLocationId, setPendingDeleteLocationId] = useState<string | null>(null);
  const [deleteLocationError, setDeleteLocationError] = useState<string | null>(null);
  const [reparentError, setReparentError] = useState<string | null>(null);
  const [registeredVendors, setRegisteredVendors] = useState<string[]>([]);
  const [vendorSearchTerm, setVendorSearchTerm] = useState("");
  const [showVendorAdd, setShowVendorAdd] = useState(false);
  const [savingVendor, setSavingVendor] = useState(false);
  const [editingVendorName, setEditingVendorName] = useState<string | null>(null);
  const [editingVendorValue, setEditingVendorValue] = useState("");
  const [renameVendorError, setRenameVendorError] = useState<string | null>(null);
  const [pendingDeleteVendor, setPendingDeleteVendor] = useState<string | null>(null);
  // Units-of-measurement state retired alongside the hidden settings
  // section. Re-add when the pantry / restaurant flow comes back online —
  // see git history for the original block.
  const [userColumnOverrides, setUserColumnOverrides] = useState<ColumnVisibilityOverrides>({});
  const [disclosures, setDisclosures] = useState<DisclosureState>(DEFAULT_DISCLOSURE_STATE);
  const [contactSubject, setContactSubject] = useState("");
  const [contactMessage, setContactMessage] = useState("");
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
          setLocations(bootstrap.locations ?? []);
          setRegisteredVendors(bootstrap.registeredVendors ?? []);
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
    if (!canManageModuleAccess && !isSupportView) return;
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
  }, [canManageModuleAccess, isSupportView]);

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
        vendors:
          typeof parsed.vendors === "boolean"
            ? parsed.vendors
            : DEFAULT_DISCLOSURE_STATE.vendors,
        allowedUnits:
          typeof parsed.allowedUnits === "boolean"
            ? parsed.allowedUnits
            : DEFAULT_DISCLOSURE_STATE.allowedUnits,
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
        helpSupport:
          typeof parsed.helpSupport === "boolean"
            ? parsed.helpSupport
            : DEFAULT_DISCLOSURE_STATE.helpSupport,
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

  // Locations are first-class entities — no merging with row.values needed
  // post-restructure. Sorted by sortOrder + name for stable display.
  const sortedLocations = [...locations].sort((a, b) =>
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name),
  );

  // Flatten the location tree into a render order: each station/root, then its
  // child leaves immediately beneath it. Drives the grouped Settings list.
  const orderedLocations = useMemo<{ loc: InventoryLocation; depth: 0 | 1 }[]>(() => {
    const rows: { loc: InventoryLocation; depth: 0 | 1 }[] = [];
    for (const node of buildLocationTree(locations)) {
      rows.push({ loc: node.location, depth: 0 });
      for (const child of node.children) rows.push({ loc: child, depth: 1 });
    }
    return rows;
  }, [locations]);

  // Search-filtered tree for the Locations list. A primary shows if it or any
  // of its sublocations match; non-matching sublocations are hidden. Drag is
  // disabled while a search is active (mirrors the Columns list).
  const isLocationSearching = locationSearchTerm.trim().length > 0;
  const filteredLocationTree = useMemo(() => {
    const tree = buildLocationTree(locations);
    const q = locationSearchTerm.trim().toLowerCase();
    if (!q) return tree;
    const matches = (l: InventoryLocation) => l.name.toLowerCase().includes(q);
    return tree
      .map((node) => {
        if (matches(node.location)) return node;
        const kids = node.children.filter(matches);
        return kids.length ? { ...node, children: kids } : null;
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);
  }, [locations, locationSearchTerm]);

  // ── Drag-to-reorder + re-home ────────────────────────────────────────────
  // Dragging vertically reorders; dragging horizontally changes nesting (drag
  // left → top level, drag right under a primary → nested). Standard dnd-kit
  // "sortable tree" projection, clamped to two levels. Replaces the old
  // per-row "Move under…" dropdown.
  const LOCATION_INDENT_PX = 24;
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [overDragId, setOverDragId] = useState<string | null>(null);
  const [dragOffsetLeft, setDragOffsetLeft] = useState(0);

  const flatLocationItems = useMemo(
    () => orderedLocations.map(({ loc, depth }) => ({
      id: loc.id,
      depth,
      parentId: (loc.parentLocationId ?? "").trim() || null,
    })),
    [orderedLocations],
  );

  /** Projected drop target: the depth + parent the active row would land at,
   *  plus the resulting full ordering. Null when not dragging. */
  const dragProjection = useMemo(() => {
    if (!activeDragId || !overDragId) return null;
    const items = flatLocationItems;
    const activeIndex = items.findIndex((i) => i.id === activeDragId);
    const overIndex = items.findIndex((i) => i.id === overDragId);
    if (activeIndex < 0 || overIndex < 0) return null;
    const activeItem = items[activeIndex];
    const newItems = arrayMove(items, activeIndex, overIndex);
    const prev = newItems[overIndex - 1];
    const next = newItems[overIndex + 1];
    // A location that has its own sublocations can't be nested (would be 3 levels).
    const activeHasChildren = locations.some((l) => (l.parentLocationId ?? "") === activeItem.id);
    const dragDepth = Math.round(dragOffsetLeft / LOCATION_INDENT_PX);
    const projected = activeItem.depth + dragDepth;
    const maxDepth = activeHasChildren ? 0 : (prev ? Math.min(prev.depth + 1, 1) : 0);
    const minDepth = next ? next.depth : 0;
    let depth = Math.max(minDepth, Math.min(projected, maxDepth));
    depth = Math.max(0, Math.min(1, depth)) as 0 | 1;
    let parentId: string | null = null;
    if (depth > 0 && prev) {
      if (depth === prev.depth) parentId = prev.parentId;
      else if (depth > prev.depth) parentId = prev.id;
      else parentId = newItems.slice(0, overIndex).reverse().find((i) => i.depth === depth)?.parentId ?? null;
    }
    return { depth: depth as 0 | 1, parentId, newOrder: newItems.map((i) => i.id) };
  }, [activeDragId, overDragId, dragOffsetLeft, flatLocationItems, locations]);

  const getItemCountForLocationId = (locationId: string): number =>
    inventoryRows.filter((r) => r.locationId === locationId).length;

  // Active (non-retired) count, SUMMED over the subtree — a station ("bucket")
  // holds no stock directly, so its count is the total across its leaves; a
  // leaf counts just its own. Matches what the grid/dashboard/reorder surface
  // (expired-but-not-retired lots still count as on-hand here).
  const getActiveCountForLocationId = (locationId: string): number => {
    const ids = locationsInScope(locations, locationId);
    return inventoryRows.filter((r) => ids.has(String(r.locationId ?? "")) && !r.values?.retiredAt).length;
  };

  // Movable stock held DIRECTLY at a location: non-retired, non-expired rows.
  // Drives "Move all contents" (count + menu gate) — retired/expired lots are
  // dead stock and shouldn't be counted or relocated.
  const getMovableCountForLocationId = (locationId: string): number =>
    inventoryRows.filter((r) =>
      r.locationId === locationId
      && !r.values?.retiredAt
      && !isExpired(r.values?.expirationDate)
    ).length;

  /** Add a primary location from the Add Location sheet. Returns an error
   *  string to keep the sheet open, or null on success (sheet closes). */
  const addLocationViaDialog = async (name: string): Promise<string | null> => {
    // A primary's name only needs to be unique among other primaries.
    const duplicate = locations.find(
      (l) => !(l.parentLocationId && l.parentLocationId.trim()) && l.name.toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) return `"${duplicate.name}" already exists`;
    try {
      const result = await addInventoryLocation(name);
      setLocations(result.locations);
      setShowLocationAdd(false);
      return null;
    } catch (err: any) {
      return err?.message ?? "Failed to add location";
    }
  };

  const onRenameLocation = async (id: string) => {
    const target = locations.find((l) => l.id === id);
    if (!target) return;
    const newName = editingLocationValue.trim();
    if (!newName || newName === target.name) {
      setEditingLocationId(null);
      setRenameLocationError(null);
      return;
    }
    // Names are unique only within a parent — check siblings, not all locations.
    const targetParent = target.parentLocationId ?? "";
    const duplicate = locations.find(
      (l) => l.id !== id && (l.parentLocationId ?? "") === targetParent && l.name.toLowerCase() === newName.toLowerCase(),
    );
    if (duplicate) {
      setRenameLocationError(`"${duplicate.name}" already exists here`);
      return;
    }
    setRenameLocationError(null);
    setSavingLocation(true);
    try {
      const result = await renameInventoryLocation(id, newName);
      setLocations(result.locations);
      setEditingLocationId(null);
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

  const resetDragState = () => {
    setActiveDragId(null);
    setOverDragId(null);
    setDragOffsetLeft(0);
  };

  /** Apply a drag: reorder and (if the horizontal projection changed it)
   *  re-home the dragged location. Vertical = order; horizontal = nesting. */
  const onLocationDragEnd = async (_event: DragEndEvent) => {
    const activeId = activeDragId;
    const proj = dragProjection;
    resetDragState();
    if (!canManageInventoryColumns || savingLocation || reorderingLocations) return;
    if (!activeId || !proj) return;

    const activeItem = flatLocationItems.find((i) => i.id === activeId);
    if (!activeItem) return;
    const newParent = proj.parentId; // string | null
    const parentChanged = (newParent ?? "") !== (activeItem.parentId ?? "");
    const currentOrder = flatLocationItems.map((i) => i.id);
    const orderChanged = proj.newOrder.some((id, i) => id !== currentOrder[i]);
    if (!parentChanged && !orderChanged) return;

    // Optimistic: stamp the new parent + per-order sortOrder locally.
    const sortByIndex = new Map(proj.newOrder.map((id, i) => [id, (i + 1) * 10]));
    setLocations((prev) => prev.map((l) => {
      const next: InventoryLocation = { ...l, sortOrder: sortByIndex.get(l.id) ?? l.sortOrder };
      if (l.id === activeId) {
        if (newParent) next.parentLocationId = newParent;
        else delete next.parentLocationId;
      }
      return next;
    }));
    setReorderingLocations(true);
    setReparentError(null);
    try {
      if (parentChanged) await setInventoryLocationParent(activeId, newParent);
      const result = await reorderInventoryLocations(proj.newOrder);
      setLocations([...result].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
    } catch (err: any) {
      console.error("Failed to move location:", err);
      setReparentError(err?.message ?? "Couldn't move that location.");
      const bootstrap = await loadInventoryBootstrap();
      setLocations([...bootstrap.locations].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
    } finally {
      setReorderingLocations(false);
    }
  };

  /** Move EVERY row at a location (active + retired history) to a destination.
   *  Unlike the grid's "Move to…" (which only sees visible/active rows), this
   *  reorganizes a location's full contents so the source ends truly empty. */
  const onMoveAllContents = async () => {
    const source = moveContentsSource;
    if (!source) return;
    const destId = moveContentsDestId.trim();
    if (!destId) {
      setMoveContentsError("Pick a destination location.");
      return;
    }
    // Only movable stock — non-retired, non-expired. Dead lots (retired history
    // / past-date) stay put; they aren't counted or relocated.
    const rowIds = inventoryRows
      .filter((r) => r.locationId === source.id && !r.values?.retiredAt && !isExpired(r.values?.expirationDate))
      .map((r) => r.id);
    if (rowIds.length === 0) {
      setMoveContentsSource(null);
      return;
    }
    setMoveContentsError(null);
    setMovingContents(true);
    try {
      await moveInventoryItems(rowIds, destId);
      const bootstrap = await loadInventoryBootstrap();
      setInventoryRows(bootstrap.items ?? []);
      setLocations(bootstrap.locations ?? []);
      setMoveContentsSource(null);
      setMoveContentsDestId("");
    } catch (err: any) {
      console.error(err);
      setMoveContentsError(err?.message ?? "Failed to move contents");
    } finally {
      setMovingContents(false);
    }
  };

  /** Create a sublocation directly under a primary via its inline "Add
   *  sublocation" input. */
  const onAddSublocation = async (parentId: string) => {
    const name = newSubName.trim();
    if (!name) return;
    // A sublocation name only needs to be unique among its siblings.
    const duplicate = locations.find(
      (l) => (l.parentLocationId ?? "") === parentId && l.name.toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) {
      setSubError(`"${duplicate.name}" already exists here`);
      return;
    }
    setSubError(null);
    setSavingLocation(true);
    try {
      const result = await addInventoryLocation(name, parentId);
      setLocations(result.locations);
      setNewSubName("");
      setSubParentId(null);
    } catch (err: any) {
      setSubError(err?.message ?? "Failed to add sublocation");
    } finally {
      setSavingLocation(false);
    }
  };

  const onRemoveLocation = async (id: string) => {
    setSavingLocation(true);
    setDeleteLocationError(null);
    try {
      const updated = await removeInventoryLocation(id);
      setLocations(updated);
      setPendingDeleteLocationId(null);
    } catch (err: any) {
      if (isLocationNotEmptyError(err)) {
        setDeleteLocationError(
          `This location still has ${err.itemCount} item${err.itemCount === 1 ? "" : "s"}. Move them out before deleting.`,
        );
      } else {
        console.error(err);
        setDeleteLocationError(err?.message ?? "Failed to remove location");
      }
    } finally {
      setSavingLocation(false);
    }
  };

  /** Render one location row (primary or sublocation). Nesting is done via the
   *  ⋯ menu (re-home) and "Add sublocation"; drag is order-only. */
  const renderLocationRow = (loc: InventoryLocation, depth: 0 | 1) => {
    const itemCount = getActiveCountForLocationId(loc.id);
    // "Move all contents" only relocates MOVABLE stock — non-retired, non-expired
    // rows held directly here. Retired/expired lots are dead stock (history or
    // past-date) and neither count nor move. Gates the menu option + its count.
    const hasContents = getMovableCountForLocationId(loc.id) > 0;
    const showMenu = depth === 0 || hasContents;
    return (
      <SortableLocationRow
        key={loc.id}
        id={loc.id}
        depth={depth}
        dragDisabled={savingLocation || reorderingLocations || editingLocationId === loc.id || isLocationSearching}
      >
        <div className="settings-column-visibility">
          {editingLocationId === loc.id ? (
            <span className="settings-column-edit">
              <input
                className={`field settings-column-edit-input${renameLocationError ? " field--error" : ""}`}
                value={editingLocationValue}
                onChange={(e) => { setEditingLocationValue(e.target.value); setRenameLocationError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") void onRenameLocation(loc.id); if (e.key === "Escape") { setEditingLocationId(null); setRenameLocationError(null); } }}
                disabled={savingLocation}
                autoFocus
                aria-invalid={!!renameLocationError || undefined}
                aria-describedby={renameLocationError ? `settings-rename-location-error-${loc.id}` : undefined}
                aria-label={`Rename ${loc.name}`}
              />
              <button
                className="button button-secondary settings-inline-action"
                onClick={() => void onRenameLocation(loc.id)}
                disabled={savingLocation || !editingLocationValue.trim()}
                type="button"
              >
                Save
              </button>
              <button
                className="button button-ghost settings-inline-action"
                onClick={() => { setEditingLocationId(null); setRenameLocationError(null); }}
                type="button"
              >
                Cancel
              </button>
              {renameLocationError ? (
                <p id={`settings-rename-location-error-${loc.id}`} className="field-error" style={{ width: "100%" }}>{renameLocationError}</p>
              ) : null}
            </span>
          ) : (
            <span>
              {loc.name}
              <span className="settings-location-count">{itemCount} item{itemCount !== 1 ? "s" : ""}</span>
            </span>
          )}
        </div>
        <div className="settings-column-actions">
          {showMenu ? (
            <details className="settings-move-menu">
              <summary className="settings-action-icon settings-move-summary" aria-label={`Actions for ${loc.name}`}>
                <MoreHorizontal aria-hidden="true" />
              </summary>
              <div className="settings-move-panel">
                {depth === 0 ? (
                  <button
                    type="button"
                    className="settings-move-option"
                    onClick={(e) => { setSubParentId(loc.id); setNewSubName(""); setSubError(null); e.currentTarget.closest("details")?.removeAttribute("open"); }}
                  >
                    <Plus size={14} aria-hidden="true" /> Add sublocation
                  </button>
                ) : null}
                {hasContents ? (
                  <button
                    type="button"
                    className="settings-move-option"
                    onClick={(e) => { setMoveContentsSource(loc); setMoveContentsDestId(""); setMoveContentsError(null); e.currentTarget.closest("details")?.removeAttribute("open"); }}
                  >
                    Move all contents…
                  </button>
                ) : null}
              </div>
            </details>
          ) : null}
          <div className="settings-action-wrap">
            <button
              className="settings-action-icon"
              onClick={() => { setEditingLocationId(loc.id); setEditingLocationValue(loc.name); }}
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
              onClick={() => { setDeleteLocationError(null); setPendingDeleteLocationId((prev) => prev === loc.id ? null : loc.id); }}
              disabled={savingLocation}
              aria-label="Remove location"
              type="button"
            >
              <Trash2 aria-hidden="true" />
            </button>
            <span className="settings-action-tip" role="tooltip">Remove</span>
          </div>
        </div>
      </SortableLocationRow>
    );
  };

  // Derive merged vendor list: registered + from item data
  const allVendors = (() => {
    const fromItems = new Set(
      inventoryRows
        .map((r) => String(r.values.vendor ?? "").trim())
        .filter((v) => v.length > 0),
    );
    const merged = new Set([...registeredVendors, ...fromItems]);
    return Array.from(merged).sort((a, b) => a.localeCompare(b));
  })();

  const filteredVendors = (() => {
    const q = vendorSearchTerm.trim().toLowerCase();
    return q ? allVendors.filter((v) => v.toLowerCase().includes(q)) : allVendors;
  })();

  const getItemCountForVendor = (vendor: string): number =>
    inventoryRows.filter((r) => String(r.values.vendor ?? "").trim() === vendor).length;

  /** Add a vendor from the Add Vendor sheet. Returns an error string to keep
   *  the sheet open, or null on success. */
  const addVendorViaDialog = async (name: string): Promise<string | null> => {
    const duplicate = allVendors.find((v) => v.toLowerCase() === name.toLowerCase());
    if (duplicate) return `"${duplicate}" already exists`;
    try {
      const vendors = await addInventoryVendor(name);
      setRegisteredVendors(vendors);
      setShowVendorAdd(false);
      return null;
    } catch (err: any) {
      return err?.message ?? "Failed to add vendor";
    }
  };

  const onRenameVendor = async (oldName: string) => {
    const newName = editingVendorValue.trim();
    if (!newName || newName === oldName) {
      setEditingVendorName(null);
      setRenameVendorError(null);
      return;
    }
    const duplicate = allVendors.find(
      (v) => v !== oldName && v.toLowerCase() === newName.toLowerCase(),
    );
    if (duplicate) {
      setRenameVendorError(`"${duplicate}" already exists`);
      return;
    }
    setRenameVendorError(null);
    setSavingVendor(true);
    try {
      const result = await renameInventoryVendor(oldName, newName);
      setRegisteredVendors(result.vendors);
      setInventoryRows((prev) =>
        prev.map((r) => {
          if (String(r.values.vendor ?? "").trim() === oldName) {
            return { ...r, values: { ...r.values, vendor: newName } };
          }
          return r;
        }),
      );
      setEditingVendorName(null);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.includes("already exists")) {
        setRenameVendorError(msg);
      } else {
        console.error(err);
      }
    } finally {
      setSavingVendor(false);
    }
  };

  const onRemoveVendor = async (name: string) => {
    setSavingVendor(true);
    try {
      const vendors = await removeInventoryVendor(name);
      setRegisteredVendors(vendors);
      setInventoryRows((prev) =>
        prev.filter((r) => String(r.values.vendor ?? "").trim() !== name),
      );
      setPendingDeleteVendor(null);
    } catch (err) {
      console.error(err);
    } finally {
      setSavingVendor(false);
    }
  };

  /** Open-state for the Add Column dialog. The dialog now collects name +
   *  type + locations in one step, replacing the previous inline form that
   *  silently auto-attached new columns to every location. */
  const [showAddColumnDialog, setShowAddColumnDialog] = useState(false);

  const onCreateColumn = async (input: {
    label: string;
    type: "text" | "number" | "date" | "link" | "boolean";
    attachedLocationIds: string[];
  }) => {
    if (!canManageInventoryColumns) return;
    setSavingColumn(true);
    try {
      const created = await createInventoryColumn(input);
      setColumns((prev) => [...prev, created].sort((a, b) => a.sortOrder - b.sortOrder));
      setShowAddColumnDialog(false);
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to add column");
    } finally {
      setSavingColumn(false);
    }
  };

  /** Column whose attachment is currently being edited via the location
   *  picker dialog. `null` when the dialog is closed. */
  const [attachmentEditTarget, setAttachmentEditTarget] = useState<InventoryColumn | null>(null);

  /** Saves the picker's selection for the editing column. */
  const onSaveAttachment = async (column: InventoryColumn, nextIds: string[]) => {
    if (!canManageInventoryColumns) return;
    setSavingColumn(true);
    try {
      await updateInventoryColumnAttachments(column.id, nextIds);
      setColumns((prev) =>
        prev.map((c) =>
          c.id === column.id ? { ...c, attachedLocationIds: nextIds } : c,
        ),
      );
      setAttachmentEditTarget(null);
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to update column attachments");
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
      toast.error(err?.message ?? "Failed to remove column");
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
      toast.error(err?.message ?? "Failed to update column visibility");
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
      toast.error(err?.message ?? "Failed to update column label");
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
      toast.error(err?.message ?? "Failed to update column type");
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
      toast.error("Users must have access to at least one module. Use \"Revoke Access\" to remove a user entirely.");
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
      toast.error(err?.message ?? "Failed to update module access");
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
      toast.error("Name is required.");
      return;
    }
    if (nextDisplayName === currentDisplayName.trim()) return;
    setSavingDisplayName(true);
    try {
      await updateCurrentUserDisplayName(nextDisplayName);
      onCurrentUserDisplayNameChange(nextDisplayName);
      setEditingDisplayName(false);
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to update your name");
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
      toast.error("Please enter a valid email address.");
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
      toast.error(err?.message ?? "Failed to start email update.");
    } finally {
      setSavingEmail(false);
    }
  };

  const onConfirmEmailVerification = async () => {
    const code = emailVerificationCode.trim();
    if (!code) {
      toast.error("Enter the verification code.");
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
      toast.error(err?.message ?? "Failed to verify email code.");
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

  const onSendContactEmail = () => {
    const trimmedSubject = contactSubject.trim();
    const trimmedMessage = contactMessage.trim();
    if (!trimmedMessage) return;
    const senderLine = currentDisplayName
      ? `${currentDisplayName} <${currentUserEmail}>`
      : currentUserEmail;
    // Embed org identity so the support console can look up the org directly —
    // no asking the customer for their org id over email.
    const orgLine = orgName ? `${orgName} (${organizationId})` : organizationId;
    const footer = [
      "---",
      `From: ${senderLine}`,
      `Organization: ${orgLine}`,
      `User ID: ${currentUserId}`,
    ].join("\n");
    const subject = encodeURIComponent(trimmedSubject || "WickOps support request");
    const body = encodeURIComponent(`${trimmedMessage}\n\n${footer}`);
    window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
  };

  const onDisclosureToggle = (key: DisclosureKey, isOpen: boolean) => {
    if (loadedDisclosureKey !== disclosureStorageKey) return;
    setDisclosures((prev) => {
      if (prev[key] === isOpen) return prev;
      return { ...prev, [key]: isOpen };
    });
  };

  const normalizedInventoryColumnSearch = inventoryColumnSearchTerm.trim().toLowerCase();
  const filteredInventoryColumns = columns
    .filter((column) => {
      if (!normalizedInventoryColumnSearch) return true;
      const label = String(column.label ?? "").toLowerCase();
      const key = String(column.key ?? "").toLowerCase();
      return label.includes(normalizedInventoryColumnSearch) || key.includes(normalizedInventoryColumnSearch);
    });

  const openBillingPortal = () => {
    setPortalLoading(true);
    createBillingPortalSession()
      .then((url) => {
        window.location.href = url;
      })
      .catch((err: any) => {
        toast.error(err?.message ?? "Could not open billing portal. Please try again.");
        setPortalLoading(false);
      });
  };

  const cancellationCountdown = (() => {
    if (!cancelAtPeriodEnd) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof currentPeriodEnd === "number" && currentPeriodEnd > 0) {
      const daysLeft = Math.max(0, Math.ceil((currentPeriodEnd - nowSec) / 86400));
      const endDate = new Date(currentPeriodEnd * 1000);
      const endDateLabel = endDate.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      return { daysLeft, endDateLabel };
    }
    return { daysLeft: null as number | null, endDateLabel: null as string | null };
  })();

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

        {cancellationCountdown && canManageModuleAccess ? (
          <button
            type="button"
            className="app-alert-card app-alert-card--caution"
            disabled={portalLoading}
            onClick={openBillingPortal}
          >
            <span className="app-alert-card__icon">
              <AlertTriangle size={16} strokeWidth={2} />
            </span>
            <span className="app-alert-card__text">
              {cancellationCountdown.daysLeft === null
                ? "Your subscription is set to cancel at the end of the current period."
                : cancellationCountdown.daysLeft === 0
                  ? `Your subscription cancels today (${cancellationCountdown.endDateLabel}).`
                  : `Your subscription cancels in ${cancellationCountdown.daysLeft} day${cancellationCountdown.daysLeft === 1 ? "" : "s"} (${cancellationCountdown.endDateLabel}).`}
              {" "}Reactivate to keep your team's access.
            </span>
            <span className="app-alert-card__action">
              {portalLoading ? "Opening\u2026" : "Reactivate \u2192"}
            </span>
          </button>
        ) : null}

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
                onClick={openBillingPortal}
              >
                {portalLoading ? "Opening…" : "Billing"}
              </button>
            ) : null}
          </div>
        </div>

        <details className="settings-section" open>
          <summary className="settings-section-title">
            Profile
            <ChevronRight size={16} className="settings-section-chevron" aria-hidden="true" />
          </summary>
          <div className="settings-field-group">
            <label className="field-label" htmlFor="settings-display-name">Display Name</label>
            <div className="settings-field-row">
              <input
                id="settings-display-name"
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
            <label className="field-label" htmlFor="settings-email">Email</label>
            <div className="settings-field-row">
              <input
                id="settings-email"
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
          <summary className="settings-section-title">
            Appearance
            <ChevronRight size={16} className="settings-section-chevron" aria-hidden="true" />
          </summary>
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

        {/* Import Data section removed — moved to the Inventory page toolbar
         *  so imports always carry an explicit destination location (a
         *  Settings-page import couldn't naturally pick a location). */}

        {canManageInventoryColumns && (
          <details
            className="settings-section"
            open={disclosures.exportData}
            onToggle={(event) => onDisclosureToggle("exportData", event.currentTarget.open)}
          >
            <summary className="settings-section-title">
              Export Data
              <ChevronRight size={16} className="settings-section-chevron" aria-hidden="true" />
            </summary>
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
          <summary className="settings-section-title">
            Team Access
            <ChevronRight size={16} className="settings-section-chevron" aria-hidden="true" />
          </summary>
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
                        className="button button-danger button-sm"
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
          ) : isSupportView ? (
            <div className="settings-columns-list">
              {loadingModuleAccess ? <div>Loading users…</div> : null}
              {!loadingModuleAccess && moduleAccessUsers.length === 0 ? <div>No users found.</div> : null}
              {moduleAccessUsers.map((user) => (
                <div className="settings-column-row" key={`support-team-${user.userId}`}>
                  <div className="settings-column-visibility">
                    <span>{user.displayName?.trim() || user.email || user.userId}</span>
                    <span className="settings-core-pill">{user.role}</span>
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

        {isOrgOwner && <SupportAccessCard open={false} />}

        {canManageModuleAccess ? (
          <details
            className="settings-section"
            open={disclosures.pendingInvites}
            onToggle={(event) => onDisclosureToggle("pendingInvites", event.currentTarget.open)}
          >
            <summary className="settings-section-title">
              Pending Invites
              {pendingInvites.length > 0 ? ` (${pendingInvites.length})` : ""}
              <ChevronRight size={16} className="settings-section-chevron" aria-hidden="true" />
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
                        className="button button-danger button-sm"
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
                <ConfirmDialog
                  title="Cancel Invite"
                  message={
                    <>
                      Cancel the invite for {email}? Their seat will be freed and the email
                      link will stop working.
                    </>
                  }
                  confirmLabel="Cancel Invite"
                  cancelLabel="Keep Invite"
                  loading={cancellingInviteEmail === email}
                  loadingLabel="Cancelling…"
                  onConfirm={() => { void onCancelInvite(email); }}
                  onCancel={() => setPendingCancelInviteEmail(null)}
                />
              );
            })() : null}
          </details>
        ) : null}

        <details
          className="settings-section"
          open={disclosures.locations}
          onToggle={(event) => onDisclosureToggle("locations", event.currentTarget.open)}
        >
          <summary className="settings-section-title">
            Locations
            <ChevronRight size={16} className="settings-section-chevron" aria-hidden="true" />
          </summary>
          {canManageInventoryColumns ? (
            <>
              <p className="settings-section-copy">
                Drag the handle to reorder. Drag a row left to move it to the top level, or right to nest it under a primary. Open the ⋯ menu to add a sublocation or move a location's contents.
              </p>
              <div className="settings-columns-toolbar">
                <div className="inventory-search-wrap settings-columns-toolbar-search">
                  <input
                    className="inventory-search-input"
                    placeholder="Search locations..."
                    value={locationSearchTerm}
                    onChange={(e) => setLocationSearchTerm(e.target.value)}
                  />
                  {locationSearchTerm ? (
                    <button
                      type="button"
                      className="inventory-search-clear"
                      onClick={() => setLocationSearchTerm("")}
                      aria-label="Clear location search"
                      title="Clear location search"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
                <div className="settings-columns-add settings-columns-add-inline">
                  <button
                    className="button button-secondary"
                    onClick={() => setShowLocationAdd(true)}
                    disabled={savingLocation}
                    type="button"
                  >
                    + Add Location
                  </button>
                </div>
              </div>
              {showLocationAdd ? (
                <AddNameDialog
                  title="Add Location"
                  label="Location name"
                  placeholder="e.g. Station 3"
                  confirmLabel="Add Location"
                  onConfirm={addLocationViaDialog}
                  onCancel={() => setShowLocationAdd(false)}
                />
              ) : null}
              <div className="settings-columns-list">
                {loadingColumns ? <div>Loading locations...</div> : null}
                {!loadingColumns && sortedLocations.length === 0 ? (
                  <div className="settings-section-copy">No locations yet. Add one above.</div>
                ) : null}
                {!loadingColumns && sortedLocations.length > 0 && filteredLocationTree.length === 0 ? (
                  <div className="settings-section-copy">No matching locations.</div>
                ) : null}
                {reparentError ? (
                  <p className="field-error" style={{ marginBottom: "0.5rem" }}>{reparentError}</p>
                ) : null}
                <DndContext
                  sensors={dragSensors}
                  collisionDetection={closestCenter}
                  onDragStart={(e: DragStartEvent) => { setActiveDragId(String(e.active.id)); setOverDragId(String(e.active.id)); setDragOffsetLeft(0); }}
                  onDragMove={(e: DragMoveEvent) => { setDragOffsetLeft(e.delta.x); }}
                  onDragOver={(e: DragOverEvent) => { setOverDragId(e.over ? String(e.over.id) : null); }}
                  onDragEnd={(event) => { void onLocationDragEnd(event); }}
                  onDragCancel={resetDragState}
                >
                  <SortableContext
                    items={filteredLocationTree.flatMap((n) => [n.location.id, ...n.children.map((c) => c.id)])}
                    strategy={verticalListSortingStrategy}
                  >
                    {filteredLocationTree.map((node) => (
                      <Fragment key={node.location.id}>
                        {renderLocationRow(node.location, node.location.id === activeDragId && dragProjection ? dragProjection.depth : 0)}
                        {node.children.map((child) => renderLocationRow(child, child.id === activeDragId && dragProjection ? dragProjection.depth : 1))}
                        {/* Inline add input — opened by the ＋ on the primary row. */}
                        {subParentId === node.location.id ? (
                          <div className="settings-sublocation-add">
                            <input
                              className={`field settings-column-edit-input${subError ? " field--error" : ""}`}
                              placeholder="Sublocation name"
                              value={newSubName}
                              onChange={(e) => { setNewSubName(e.target.value); setSubError(null); }}
                              onKeyDown={(e) => { if (e.key === "Enter") void onAddSublocation(node.location.id); if (e.key === "Escape") { setSubParentId(null); setNewSubName(""); setSubError(null); } }}
                              disabled={savingLocation}
                              autoFocus
                              aria-label={`New sublocation in ${node.location.name}`}
                            />
                            <button
                              className="button button-secondary settings-inline-action"
                              onClick={() => void onAddSublocation(node.location.id)}
                              disabled={savingLocation || !newSubName.trim()}
                              type="button"
                            >
                              Add
                            </button>
                            <button
                              className="button button-ghost settings-inline-action"
                              onClick={() => { setSubParentId(null); setNewSubName(""); setSubError(null); }}
                              type="button"
                            >
                              Cancel
                            </button>
                            {subError ? (
                              <p className="field-error" style={{ width: "100%" }}>{subError}</p>
                            ) : null}
                          </div>
                        ) : null}
                      </Fragment>
                    ))}
                  </SortableContext>
                </DndContext>
              </div>
              {pendingDeleteLocationId ? (() => {
                const target = locations.find((l) => l.id === pendingDeleteLocationId);
                if (!target) return null;
                const deleteLocItemCount = getItemCountForLocationId(target.id);
                return (
                  <ConfirmDialog
                    title="Remove Location"
                    message={
                      deleteLocationError
                        ? deleteLocationError
                        : deleteLocItemCount > 0
                          ? `"${target.name}" has ${deleteLocItemCount} item${deleteLocItemCount !== 1 ? "s" : ""}. Move them to another location first.`
                          : `Remove "${target.name}"?`
                    }
                    confirmLabel="Remove"
                    loading={savingLocation}
                    loadingLabel="Removing…"
                    onConfirm={() => { void onRemoveLocation(target.id); }}
                    onCancel={() => { setPendingDeleteLocationId(null); setDeleteLocationError(null); }}
                  />
                );
              })() : null}
              {moveContentsSource ? (() => {
                const source = moveContentsSource;
                // Move-contents relocates MOVABLE rows held DIRECTLY at this
                // location — non-retired, non-expired (matches onMoveAllContents).
                // Count those same rows so the dialog reflects what moves, NOT
                // the subtree roll-up the list shows for a bucket, and NOT dead
                // (retired/expired) stock.
                const total = getMovableCountForLocationId(source.id);
                const sourceHasChildren = locations.some((l) => (l.parentLocationId ?? "") === source.id);
                // Match the New Order picker: show buckets AND leaves with the
                // full "Station / Cabinet" path; stations render as disabled
                // headers since stock can only land on a leaf. Exclude the
                // source itself.
                const destOptions = buildLocationPickerEntries(locations)
                  .filter((entry) => entry.id !== source.id)
                  .map((entry) => ({
                    value: entry.id,
                    label: entry.label,
                    depth: entry.depth,
                    ...(entry.isStation ? { disabled: true } : {}),
                  }));
                return (
                  <ConfirmDialog
                    title={`Move contents of ${source.name}`}
                    message={
                      <div className="settings-move-contents-dialog">
                        <p>
                          Move {total} item{total !== 1 ? "s" : ""} held directly in
                          {" "}<strong>{source.name}</strong>
                          {sourceHasChildren ? " (its sublocations keep their own)" : ""} to:
                        </p>
                        <CustomDropdown
                          ariaLabel="Destination location"
                          placeholder="Select a location…"
                          value={moveContentsDestId}
                          onChange={(v) => { setMoveContentsDestId(v); setMoveContentsError(null); }}
                          options={destOptions}
                        />
                        {moveContentsError ? (
                          <p className="field-error">{moveContentsError}</p>
                        ) : null}
                      </div>
                    }
                    confirmLabel="Move contents"
                    loading={movingContents}
                    loadingLabel="Moving…"
                    onConfirm={() => { void onMoveAllContents(); }}
                    onCancel={() => { setMoveContentsSource(null); setMoveContentsDestId(""); setMoveContentsError(null); }}
                  />
                );
              })() : null}
            </>
          ) : isSupportView ? (
            locations.length === 0 ? (
              <p className="settings-section-copy">No locations.</p>
            ) : (
              <ul className="settings-readonly-list">
                {locations.map((loc) => (
                  <li key={loc.id}>{loc.name}</li>
                ))}
              </ul>
            )
          ) : (
            <p className="settings-section-copy">
              Only administrators can manage locations.
            </p>
          )}
        </details>

        <details
          className="settings-section"
          open={disclosures.vendors}
          onToggle={(event) => onDisclosureToggle("vendors", event.currentTarget.open)}
        >
          <summary className="settings-section-title">
            Vendors
            <ChevronRight size={16} className="settings-section-chevron" aria-hidden="true" />
          </summary>
          {canManageInventoryColumns ? (
            <>
              <p className="settings-section-copy">
                Add the vendors you order from.
              </p>
              <div className="settings-columns-toolbar">
                <div className="inventory-search-wrap settings-columns-toolbar-search">
                  <input
                    className="inventory-search-input"
                    placeholder="Search vendors..."
                    value={vendorSearchTerm}
                    onChange={(e) => setVendorSearchTerm(e.target.value)}
                  />
                  {vendorSearchTerm ? (
                    <button
                      type="button"
                      className="inventory-search-clear"
                      onClick={() => setVendorSearchTerm("")}
                      aria-label="Clear vendor search"
                      title="Clear vendor search"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
                <div className="settings-columns-add settings-columns-add-inline">
                  <button
                    className="button button-secondary"
                    onClick={() => setShowVendorAdd(true)}
                    disabled={savingVendor}
                    type="button"
                  >
                    + Add Vendor
                  </button>
                </div>
              </div>
              {showVendorAdd ? (
                <AddNameDialog
                  title="Add Vendor"
                  label="Vendor name"
                  placeholder="e.g. BoundTree"
                  confirmLabel="Add Vendor"
                  onConfirm={addVendorViaDialog}
                  onCancel={() => setShowVendorAdd(false)}
                />
              ) : null}
              <div className="settings-columns-list">
                {loadingColumns ? <div>Loading vendors...</div> : null}
                {!loadingColumns && allVendors.length === 0 ? (
                  <div className="settings-section-copy">No vendors yet. Add one above.</div>
                ) : null}
                {!loadingColumns && allVendors.length > 0 && filteredVendors.length === 0 ? (
                  <div className="settings-section-copy">No matching vendors.</div>
                ) : null}
                {filteredVendors.map((vendor) => {
                  return (
                    <div key={vendor} className="settings-column-row">
                      <div className="settings-column-visibility">
                        {editingVendorName === vendor ? (
                          <span className="settings-column-edit">
                            <input
                              className={`field settings-column-edit-input${renameVendorError ? " field--error" : ""}`}
                              value={editingVendorValue}
                              onChange={(e) => { setEditingVendorValue(e.target.value); setRenameVendorError(null); }}
                              onKeyDown={(e) => { if (e.key === "Enter") void onRenameVendor(vendor); if (e.key === "Escape") { setEditingVendorName(null); setRenameVendorError(null); } }}
                              disabled={savingVendor}
                              autoFocus
                              aria-invalid={!!renameVendorError || undefined}
                              aria-describedby={renameVendorError ? `settings-rename-vendor-error-${vendor}` : undefined}
                              aria-label={`Rename ${vendor}`}
                            />
                            <button
                              className="button button-secondary settings-inline-action"
                              onClick={() => void onRenameVendor(vendor)}
                              disabled={savingVendor || !editingVendorValue.trim()}
                              type="button"
                            >
                              Save
                            </button>
                            <button
                              className="button button-ghost settings-inline-action"
                              onClick={() => { setEditingVendorName(null); setRenameVendorError(null); }}
                              type="button"
                            >
                              Cancel
                            </button>
                            {renameVendorError ? (
                              <p id={`settings-rename-vendor-error-${vendor}`} className="field-error" style={{ width: "100%" }}>{renameVendorError}</p>
                            ) : null}
                          </span>
                        ) : (
                          <span>{vendor}</span>
                        )}
                      </div>
                      <div className="settings-column-actions">
                        <div className="settings-action-wrap">
                          <button
                            className="settings-action-icon"
                            onClick={() => { setEditingVendorName(vendor); setEditingVendorValue(vendor); }}
                            disabled={savingVendor}
                            aria-label="Rename vendor"
                            type="button"
                          >
                            <Pencil aria-hidden="true" />
                          </button>
                          <span className="settings-action-tip" role="tooltip">Rename</span>
                        </div>
                        <div className="settings-action-wrap">
                          <button
                            className="settings-action-icon settings-action-icon--danger"
                            onClick={() => setPendingDeleteVendor((prev) => prev === vendor ? null : vendor)}
                            disabled={savingVendor}
                            aria-label="Remove vendor"
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
              {pendingDeleteVendor ? (() => {
                const vendorName = pendingDeleteVendor;
                const deleteVendorItemCount = getItemCountForVendor(vendorName);
                return (
                  <ConfirmDialog
                    title="Remove Vendor"
                    message={
                      deleteVendorItemCount > 0
                        ? `"${vendorName}" has ${deleteVendorItemCount} item${deleteVendorItemCount !== 1 ? "s" : ""} that will become unassigned.`
                        : `Remove "${vendorName}"?`
                    }
                    confirmLabel="Remove"
                    loading={savingVendor}
                    loadingLabel="Removing…"
                    onConfirm={() => { void onRemoveVendor(vendorName); }}
                    onCancel={() => setPendingDeleteVendor(null)}
                  />
                );
              })() : null}
            </>
          ) : isSupportView ? (
            registeredVendors.length === 0 ? (
              <p className="settings-section-copy">No vendors.</p>
            ) : (
              <ul className="settings-readonly-list">
                {registeredVendors.map((vendor) => (
                  <li key={vendor}>{vendor}</li>
                ))}
              </ul>
            )
          ) : (
            <p className="settings-section-copy">
              Only administrators can manage vendors.
            </p>
          )}
        </details>

        {/* Units of measurement section hidden during the EMS warm-market
         *  push. State + loaders below remain plumbed so we can restore the
         *  section in one edit when pantry / restaurant orgs come online. */}

        <details
          className="settings-section"
          open={disclosures.inventoryColumns}
          onToggle={(event) => onDisclosureToggle("inventoryColumns", event.currentTarget.open)}
        >
          <summary className="settings-section-title">
            Columns
            <ChevronRight size={16} className="settings-section-chevron" aria-hidden="true" />
          </summary>
          {canManageInventoryColumns ? (
            <>
              <p className="settings-section-copy">
                Drag the handle to reorder columns. Show or hide columns with the checkbox. Required columns cannot be deleted.
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
                  <button
                    className="button button-secondary"
                    onClick={() => setShowAddColumnDialog(true)}
                    disabled={savingColumn}
                    type="button"
                  >
                    + Add Column
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
                          allLocations={locations}
                          setEditingLabel={setEditingLabel}
                          onToggleColumnVisibility={onToggleColumnVisibility}
                          onEditAttachment={(c) => setAttachmentEditTarget(c)}
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
                  <ConfirmDialog
                    title="Delete Column"
                    message={
                      colToDelete
                        ? `Delete "${colToDelete.label}"? This cannot be undone.`
                        : "Delete this column? This cannot be undone."
                    }
                    confirmLabel="Delete"
                    loading={savingColumn}
                    loadingLabel="Deleting…"
                    onConfirm={() => { void onDeleteColumn(colId); }}
                    onCancel={() => setPendingDeleteColumnId(null)}
                  />
                );
              })() : null}
              {attachmentEditTarget ? (
                <LocationPickerDialog
                  title={`Where should "${attachmentEditTarget.label}" appear?`}
                  subtitle="Pick the locations where this column should render. Use All to enable everywhere or None to hide it everywhere."
                  locations={locations}
                  initialSelectedIds={attachmentEditTarget.attachedLocationIds ?? []}
                  confirmLabel="Save"
                  onConfirm={(ids) => onSaveAttachment(attachmentEditTarget, ids)}
                  onCancel={() => setAttachmentEditTarget(null)}
                />
              ) : null}
              {showAddColumnDialog ? (
                <AddColumnDialog
                  locations={locations}
                  onCreate={onCreateColumn}
                  onCancel={() => setShowAddColumnDialog(false)}
                />
              ) : null}
            </>
          ) : isSupportView ? (
            columns.length === 0 ? (
              <p className="settings-section-copy">No columns.</p>
            ) : (
              <ul className="settings-readonly-list">
                {columns.map((col) => (
                  <li key={col.id}>
                    {col.label}
                    <span className="settings-readonly-meta">{col.type}{col.isCore ? " · core" : ""}</span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p className="settings-section-copy">
              Only administrators can manage inventory columns.
            </p>
          )}
        </details>

        <details
          className="settings-section"
          open={disclosures.helpSupport}
          onToggle={(event) => onDisclosureToggle("helpSupport", event.currentTarget.open)}
        >
          <summary className="settings-section-title">
            Help &amp; Support
            <ChevronRight size={16} className="settings-section-chevron" aria-hidden="true" />
          </summary>
          <p className="settings-section-copy">
            Have a question, bug report, or feature request? Send us a message and we'll get back to you.
          </p>
          <div className="settings-field-group">
            <label className="field-label" htmlFor="contact-subject">Subject</label>
            <input
              id="contact-subject"
              className="field"
              type="text"
              placeholder="Briefly, what's this about?"
              value={contactSubject}
              onChange={(event) => setContactSubject(event.target.value)}
            />
          </div>
          <div className="settings-field-group">
            <label className="field-label" htmlFor="contact-message">Message</label>
            <textarea
              id="contact-message"
              className="settings-contact-textarea"
              placeholder="Tell us what's going on..."
              value={contactMessage}
              onChange={(event) => setContactMessage(event.target.value)}
              rows={6}
            />
          </div>
          <div className="settings-import-actions">
            <button
              type="button"
              className="button button-primary button-sm"
              onClick={onSendContactEmail}
              disabled={!contactMessage.trim()}
            >
              Send Email
            </button>
          </div>
        </details>

      </div>
    </section>
  );
}

/** Sortable wrapper for a location row. Provides the drag handle + dnd-kit
 *  wiring; the caller passes the row's content as children. Mirrors
 *  SortableColumnRow but for the (2-level) locations list. */
function SortableLocationRow({
  id,
  depth,
  dragDisabled,
  children,
}: {
  id: string;
  depth: 0 | 1;
  dragDisabled: boolean;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: dragDisabled,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    zIndex: isDragging ? 2 : undefined,
    marginLeft: depth === 1 ? "1.25rem" : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`settings-column-row${isDragging ? " settings-column-row--dragging" : ""}`}
    >
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
      {children}
    </div>
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
  /** All locations in the org. Used both to compute the checkbox state
   *  (all-on / mixed / all-off) and to populate the location picker dialog
   *  the checkbox triggers. */
  allLocations: InventoryLocation[];
  setEditingLabel: (value: string) => void;
  /** Required-column visibility toggle (the per-user override path).
   *  Required columns always render in every location structurally; this
   *  toggle lets a user hide them from their personal view. */
  onToggleColumnVisibility: (column: InventoryColumn) => void;
  /** Custom-column attachment editor. Opens the location picker dialog. */
  onEditAttachment: (column: InventoryColumn) => void;
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
  allLocations,
  setEditingLabel,
  onToggleColumnVisibility,
  onEditAttachment,
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
          {(() => {
            // Required (core) columns always render in every location — the
            // checkbox is the per-user "show in MY view" override and stays
            // a simple boolean.
            //
            // Custom columns: the checkbox represents attachment across
            // locations (all / mixed / none). Clicking it opens a picker
            // dialog instead of toggling directly, so the user can choose
            // exactly where the column appears.
            if (isLocked) {
              const visible = userColumnOverrides[column.id] !== undefined
                ? userColumnOverrides[column.id]
                : column.isVisible;
              return (
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={() => onToggleColumnVisibility(column)}
                  disabled={savingColumn}
                />
              );
            }
            const attached = column.attachedLocationIds ?? [];
            const total = allLocations.length;
            const onCount = attached.filter((id) => allLocations.some((l) => l.id === id)).length;
            const allOn = total > 0 && onCount === total;
            const someOn = onCount > 0 && onCount < total;
            return (
              <input
                type="checkbox"
                checked={allOn}
                ref={(el) => {
                  // React's checked prop doesn't cover the indeterminate
                  // visual state — must be set on the DOM node imperatively.
                  if (el) el.indeterminate = someOn;
                }}
                onChange={() => onEditAttachment(column)}
                onClick={(e) => {
                  // Clicking a checkbox normally fires onChange after
                  // toggling its checked state. We hijack to open the
                  // picker without mutating state directly — the dialog is
                  // the source of truth for the new attachment set.
                  e.preventDefault();
                  onEditAttachment(column);
                }}
                disabled={savingColumn}
                aria-label={`Edit locations for ${column.label}`}
              />
            );
          })()}
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
          // "Required" reads as "you can't get rid of this" — which is what
          // the pill actually represents. Internally we still call these
          // "core" columns (system-defined, can't be deleted, can't have
          // type changed), but customers find "Required" clearer than the
          // engineering word.
          <span className="settings-core-pill">Required</span>
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
