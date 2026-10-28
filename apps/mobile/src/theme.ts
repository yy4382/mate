import { useColorScheme } from "react-native";

const colors = {
  light: {
    background: "#FFFFFF",
    grouped: "#F3F3F6",
    subtle: "#F3F3F6",
    surface: "#FFFFFF",
    foreground: "#1D2027",
    muted: "#656973",
    accent: "#285EC8",
    tint: "#EDF2FC",
    border: "#E4E5EA",
    success: "#287046",
    warning: "#8D5A14",
    danger: "#BC3544",
  },
  dark: {
    background: "#111215",
    grouped: "#07080B",
    subtle: "#1C1E23",
    surface: "#1C1E23",
    foreground: "#F1F2F5",
    muted: "#A1A6B2",
    accent: "#94B8FF",
    tint: "#202D49",
    border: "#34373F",
    success: "#A4D6B0",
    warning: "#EDC785",
    danger: "#FF9BA6",
  },
};
export function useTheme() {
  return colors[useColorScheme() === "dark" ? "dark" : "light"];
}
export const type = {
  body: { fontSize: 17, lineHeight: 26 },
  title: { fontSize: 20, lineHeight: 28, fontWeight: "600" },
  caption: { fontSize: 13, lineHeight: 19 },
} as const;
