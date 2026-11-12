import * as React from "react";
import * as ReactNative from "react-native";
import * as ReactQuery from "@tanstack/react-query";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactJsxDevRuntime from "react/jsx-dev-runtime";
import * as Unistyles from "react-native-unistyles";
import * as Zod from "zod";
import * as PluginSdk from "@omp-desktop/plugin";
import * as PluginServerSdk from "@omp-desktop/plugin/server";
import * as OmpClient from "@omp-desktop/client";
import * as ReactI18next from "react-i18next";
import * as LucideIcons from "lucide-react-native";
import type { PluginClientSetup } from "@omp-desktop/plugin";

const sharedModules: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": ReactJsxRuntime,
  "react/jsx-dev-runtime": ReactJsxDevRuntime,
  "react-native": ReactNative,
  "react-native-unistyles": Unistyles,
  "@tanstack/react-query": ReactQuery,
  "react-i18next": ReactI18next,
  "lucide-react-native": LucideIcons,
  zod: Zod,
  "@omp-desktop/plugin": PluginSdk,
  "@omp-desktop/plugin/server": PluginServerSdk,
  "@omp-desktop/client": OmpClient,
};

/** Only call after this exact client bundle has been approved on this machine. */
export function loadTrustedPluginClient(bundle: string): PluginClientSetup {
  const factory: unknown = new Function(`"use strict"; return (${bundle});`)();
  if (typeof factory !== "function") throw new Error("Plugin client bundle must export a CommonJS factory");
  const module: unknown = factory((name: string) => {
    if (!Object.hasOwn(sharedModules, name)) throw new Error(`Plugin shared module is unavailable: ${name}`);
    return sharedModules[name];
  });
  if (typeof module === "function") return module as PluginClientSetup;
  if (typeof module !== "object" || module === null || !("default" in module) || typeof module.default !== "function") {
    throw new Error("Plugin client entry must default-export a setup function");
  }
  return module.default as PluginClientSetup;
}
