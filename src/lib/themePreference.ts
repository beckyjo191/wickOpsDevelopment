export type ThemePreference = "system" | "light" | "dark";

export const THEME_PREFERENCE_STORAGE_KEY = "wickops.themePreference";

const isThemePreference = (value: unknown): value is ThemePreference =>
  value === "system" || value === "light" || value === "dark";

export const loadThemePreference = (): ThemePreference => {
  try {
    const raw = window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY);
    return isThemePreference(raw) ? raw : "system";
  } catch {
    return "system";
  }
};

export const saveThemePreference = (preference: ThemePreference): void => {
  try {
    window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // No-op: storage may be unavailable in private mode or locked environments.
  }
};

export const applyThemePreference = (preference: ThemePreference): void => {
  const root = document.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-theme");
    return;
  }
  root.setAttribute("data-theme", preference);
};
