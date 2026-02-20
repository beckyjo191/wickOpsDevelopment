export type UsageFormPreferences = {
  mode: "all" | "custom";
  enabledColumnKeys: string[];
};

export const DEFAULT_USAGE_FORM_PREFERENCES: UsageFormPreferences = {
  mode: "all",
  enabledColumnKeys: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const loadUsageFormPreferences = (
  storageKey: string,
): UsageFormPreferences => {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return DEFAULT_USAGE_FORM_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return DEFAULT_USAGE_FORM_PREFERENCES;
    if (
      (parsed.mode === "all" || parsed.mode === "custom") &&
      Array.isArray(parsed.enabledColumnKeys)
    ) {
      return {
        mode: parsed.mode,
        enabledColumnKeys: parsed.enabledColumnKeys
          .map((item) => String(item).trim().toLowerCase())
          .filter((item) => item.length > 0),
      };
    }

    // Legacy migration from showLocation/showNotes format.
    if (typeof parsed.showLocation === "boolean" || typeof parsed.showNotes === "boolean") {
      const enabledColumnKeys: string[] = [];
      if (parsed.showLocation === true) {
        enabledColumnKeys.push("location");
      }
      if (parsed.showNotes === true) {
        enabledColumnKeys.push("notes", "note");
      }
      return {
        mode: "custom",
        enabledColumnKeys,
      };
    }

    return DEFAULT_USAGE_FORM_PREFERENCES;
  } catch {
    return DEFAULT_USAGE_FORM_PREFERENCES;
  }
};

export const saveUsageFormPreferences = (
  storageKey: string,
  preferences: UsageFormPreferences,
): void => {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    // No-op: storage may be unavailable in private mode or locked environments.
  }
};
