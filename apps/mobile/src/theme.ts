import { useColorScheme } from "react-native";

const colors = {
  light: {
    background: "#ffffff",
    subtle: "#fafafa",
    foreground: "#171717",
    muted: "#666666",
    border: "#eaeaea",
  },
  dark: {
    background: "#0a0a0a",
    subtle: "#111111",
    foreground: "#ededed",
    muted: "#a1a1a1",
    border: "#262626",
  },
};

export function useTheme() {
  return colors[useColorScheme() === "dark" ? "dark" : "light"];
}
