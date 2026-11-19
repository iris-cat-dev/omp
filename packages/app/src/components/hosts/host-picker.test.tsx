import { expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  ADD_HOST_OPTION_ID,
  ALL_HOSTS_OPTION_ID,
  getHostPickerLabel,
} from "./host-picker-constants";

const hosts = [{ serverId: "host-a", label: "Host A" }];

it.each([
  ["host-a", undefined, "Host A"],
  ["missing", undefined, "Host"],
  [ALL_HOSTS_OPTION_ID, { includeAllHost: true }, "All hosts"],
  ["missing", { includeAllHost: true }, "All hosts"],
  [ALL_HOSTS_OPTION_ID, undefined, "Host"],
  [ADD_HOST_OPTION_ID, { includeAddHost: true }, "Add host"],
])("resolves %s", (value, config, expected) => {
  expect(getHostPickerLabel(hosts, value, config)).toBe(expected);
});

it("translates the all-hosts option but preserves a host with the same display name", () => {
  const namedHosts = [{ serverId: "host-b", label: "All hosts" }];
  const t = i18n.getFixedT("zh-CN");
  const config = { includeAllHost: true };
  expect(getHostPickerLabel(namedHosts, ALL_HOSTS_OPTION_ID, config, t)).toBe("所有主机");
  expect(getHostPickerLabel(namedHosts, "host-b", config, t)).toBe("All hosts");
});
