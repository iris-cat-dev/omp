import { createElement, type ComponentType } from "react";

const testTheme = {
  colorScheme: "light",
  colors: {
    foreground: "#111111",
    foregroundMuted: "#666666",
    statusSuccess: "#15803d",
    statusDanger: "#b91c1c",
    statusWarning: "#d97706",
    statusMerged: "#7c3aed",
    // The light band's values, so a test can name the colour it expects.
    statusDotSuccess: "#299f51",
    statusDotDanger: "#f12e2f",
    statusDotWarning: "#b37824",
    statusDotRunning: "#268ae0",
    accent: "#2563eb",
    accentForeground: "#ffffff",
    destructive: "#dc2626",
    destructiveForeground: "#ffffff",
    surface1: "#fafafa",
    surface2: "#f4f4f5",
    surface3: "#e4e4e7",
    surfaceComposer: "#ffffff",
    popover: "#ffffff",
    border: "#e4e4e7",
    borderAccent: "#a1a1aa",
    syntax: {
      keyword: "#7c3aed",
      comment: "#6b7280",
      string: "#15803d",
      number: "#b45309",
      literal: "#b45309",
      function: "#2563eb",
      definition: "#2563eb",
      class: "#b45309",
      type: "#0891b2",
      tag: "#b91c1c",
      attribute: "#b45309",
      property: "#0f766e",
      variable: "#111111",
      operator: "#111111",
      punctuation: "#666666",
      regexp: "#be185d",
      escape: "#be185d",
      meta: "#6b7280",
      heading: "#111111",
      link: "#2563eb",
    },
    palette: {
      amber: { 500: "#f59e0b" },
      blue: { 300: "#93c5fd" },
      green: { 500: "#22c55e" },
      red: { 300: "#fca5a5" },
      yellow: { 400: "#facc15" },
      zinc: { 600: "#52525b" },
      white: "#ffffff",
    },
  },
  borderWidth: { 1: 1 },
  spacing: [0, 4, 8, 12, 16, 20, 24, 28, 32],
  fontSize: {
    xs: 12,
    sm: 14,
    base: 16,
  },
  fontFamily: {
    ui: "sans-serif",
    mono: "monospace",
  },
  fontWeight: {
    normal: "400",
    medium: "500",
  },
  borderRadius: {
    base: 4,
    md: 6,
    lg: 8,
    xl: 12,
    full: 9999,
  },
  iconSize: { sm: 16, md: 20 },
  opacity: { 50: 0.5 },
  shadow: {
    sm: {
      shadowColor: "rgba(0, 0, 0, 0.02)",
      shadowOffset: { width: 0, height: 2 },
      shadowRadius: 8,
      elevation: 2,
    },
    md: {
      shadowColor: "rgba(0, 0, 0, 0.04)",
      shadowOffset: { width: 0, height: 4 },
      shadowRadius: 16,
      elevation: 4,
    },
    lg: {
      shadowColor: "rgba(0, 0, 0, 0.08)",
      shadowOffset: { width: 0, height: 8 },
      shadowRadius: 24,
      elevation: 8,
    },
  },
};

type StyleFactory<T> = (theme: typeof testTheme) => T;

function isStyleFactory<T>(styles: T | StyleFactory<T>): styles is StyleFactory<T> {
  return typeof styles === "function";
}

export const StyleSheet = {
  create: <T>(styles: T | StyleFactory<T>): T =>
    isStyleFactory(styles) ? styles(testTheme) : styles,
};

export const withUnistyles = <P extends object>(
  Component: ComponentType<P>,
  mapProps?: (theme: typeof testTheme) => Partial<P>,
): ComponentType<P> =>
  mapProps
    ? (props: P) => createElement(Component, { ...mapProps(testTheme), ...props })
    : Component;

export const useUnistyles = () => ({
  theme: testTheme,
  rt: {},
  breakpoint: undefined,
});

export const UnistylesRuntime = {
  setTheme: () => undefined,
  themeName: "light",
};
