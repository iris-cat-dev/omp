import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { expect, test } from "vitest";

const { deduplicateSdkSharp } = createRequire(import.meta.url)("./after-pack.js");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-image-package-"));
  const resources = path.join(directory, "resources");
  const sdk = path.join(resources, "omp-sdk");
  const desktop = path.join(resources, "app");
  const target = `${process.platform}-${process.arch}`;
  const native = `@img/sharp-${target}`;
  const libvips = `@img/sharp-libvips-${target}`;
  function packageAt(root, name, data = {}) {
    const location = path.join(root, "node_modules", name);
    fs.mkdirSync(location, { recursive: true });
    fs.writeFileSync(
      path.join(location, "package.json"),
      JSON.stringify({ name, version: "1.0.0", main: "index.js", ...data }),
    );
    fs.writeFileSync(path.join(location, "index.js"), "module.exports = {};\n");
    return location;
  }
  fs.mkdirSync(desktop, { recursive: true });
  fs.writeFileSync(path.join(desktop, "package.json"), JSON.stringify({ name: "desktop" }));
  packageAt(sdk, "@oh-my-pi/pi-coding-agent");
  for (const root of [sdk, desktop]) {
    packageAt(root, "sharp", {
      version: "0.35.4",
      dependencies: { semver: root === sdk ? "7.8.5" : "^7.7.3" },
      optionalDependencies: { [native]: "0.35.4", [libvips]: "1.3.3" },
    });
    packageAt(root, "semver", { version: "7.8.5" });
    const addon = packageAt(root, native, {
      version: "0.35.4",
      exports: { "./package": "./package.json" },
      os: [process.platform],
      cpu: [process.arch],
      optionalDependencies: { [libvips]: "1.3.3" },
    });
    fs.writeFileSync(path.join(addon, "binding.node"), "native-release-A");
    const library = packageAt(root, libvips, {
      version: "1.3.3",
      exports: { "./package": "./package.json" },
      os: [process.platform],
      cpu: [process.arch],
    });
    fs.writeFileSync(path.join(library, "libvips.so"), "vips-release-A");
  }
  return { directory, resources, sdk, desktop, native };
}

test("different native builds with the same version are rejected before either runtime is replaced", () => {
  const f = fixture();
  try {
    const sdkBinary = path.join(f.sdk, "node_modules", f.native, "binding.node");
    const desktopBinary = path.join(f.desktop, "node_modules", f.native, "binding.node");
    fs.writeFileSync(sdkBinary, "native-release-B");
    expect(() => deduplicateSdkSharp(f.resources, process.platform, process.arch)).toThrow(
      /native payloads do not match/,
    );
    expect(fs.readFileSync(sdkBinary, "utf8")).toBe("native-release-B");
    expect(fs.readFileSync(desktopBinary, "utf8")).toBe("native-release-A");
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("an SDK dependency linked outside the App is rejected without modifying its source", () => {
  const f = fixture();
  try {
    const sharp = path.join(f.sdk, "node_modules", "sharp");
    const external = path.join(f.directory, "source-sharp");
    fs.renameSync(sharp, external);
    fs.symlinkSync(external, sharp, process.platform === "win32" ? "junction" : "dir");
    const marker = path.join(external, "source-payload");
    fs.writeFileSync(marker, "source-owned");
    expect(() => deduplicateSdkSharp(f.resources, process.platform, process.arch)).toThrow(
      /escapes its packaged runtime/,
    );
    expect(fs.readFileSync(marker, "utf8")).toBe("source-owned");
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
