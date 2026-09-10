// Frontend and local bridge share the same fixed theme catalogue.
export const THEMES = [
  { id: "glacier", name: "冰川蓝" },
  { id: "sakura", name: "樱花粉" },
  { id: "mint", name: "薄荷绿" },
  { id: "lavender", name: "雾霭紫" },
  { id: "peach", name: "蜜桃橙" },
  { id: "cloud", name: "云朵白" },
  { id: "midnight", name: "午夜深色" },
];

// Existing installations keep their dark appearance until the user chooses.
export const DEFAULT_THEME = "midnight";
export function isTheme(value) {
  return typeof value === "string" && THEMES.some((theme) => theme.id === value);
}
