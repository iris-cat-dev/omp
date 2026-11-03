import { createRequire } from "node:module";
import path from "node:path";
import type * as Koffi from "koffi" with { "resolution-mode": "require" };
import type { ExternalAppRuntime } from "./external-app-runtime.js";

const nativeRequire = createRequire(__filename);
const UTF8 = 0x08000100;
let findBrowser: (() => string) | undefined;

function loadBrowserLookup(): () => string {
  const koffi = nativeRequire("koffi") as typeof Koffi;
  if (process.platform === "win32") {
    const query = koffi
      .load("shlwapi.dll")
      .func(
        "int32_t __stdcall AssocQueryStringW(uint32_t flags, uint32_t kind, str16 association, str16 verb, void *output, _Inout_ uint32_t *length)",
      );
    return () => {
      // ASSOCF_IS_PROTOCOL resolves the user's HTTPS default, not the .html association.
      // ASSOCSTR_EXECUTABLE returns an executable path, never a shell command template.
      const length = [0];
      const sizeResult = query(0x1000, 2, "https", "open", null, length);
      if (sizeResult !== 1 || length[0]! < 2 || length[0]! > 32768) {
        throw new Error(`Cannot discover the system browser (HRESULT ${sizeResult})`);
      }
      const buffer = Buffer.alloc(length[0]! * 2);
      const result = query(0x1000, 2, "https", "open", buffer, length);
      if (result !== 0) throw new Error(`Cannot discover the system browser (HRESULT ${result})`);
      const executable = buffer.toString("utf16le").split("\0", 1)[0]!;
      if (!path.win32.isAbsolute(executable) || !/\.(exe|com)$/i.test(executable)) {
        throw new Error("The system browser must be a native executable");
      }
      return executable;
    };
  }
  if (process.platform === "darwin") {
    const core = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
    const services = koffi.load("/System/Library/Frameworks/CoreServices.framework/CoreServices");
    const createString = core.func(
      "void *CFStringCreateWithCString(void *allocator, str text, uint32_t encoding)",
    );
    const release = core.func("void CFRelease(void *value)");
    const getLength = core.func("intptr_t CFStringGetLength(void *value)");
    const getString = core.func(
      "bool CFStringGetCString(void *value, void *buffer, intptr_t size, uint32_t encoding)",
    );
    const copyHandler = services.func("void *LSCopyDefaultHandlerForURLScheme(void *scheme)");
    return () => {
      const scheme = createString(null, "https", UTF8);
      if (!scheme) throw new Error("Cannot create the system browser query");
      let handler: unknown;
      try {
        handler = copyHandler(scheme);
        if (!handler) throw new Error("No system browser is configured");
        const buffer = Buffer.alloc(Number(getLength(handler)) * 4 + 1);
        if (!getString(handler, buffer, buffer.length, UTF8)) {
          throw new Error("Cannot read the system browser identifier");
        }
        return buffer.toString("utf8").split("\0", 1)[0]!;
      } finally {
        if (handler) release(handler);
        release(scheme);
      }
    };
  }
  throw new Error(`System browser discovery is unavailable on ${process.platform}`);
}

/** Open a validated local webpage with the HTTPS browser, even when HTML is associated with an editor. */
export async function openSystemBrowser(url: string, runtime: ExternalAppRuntime): Promise<void> {
  findBrowser ??= loadBrowserLookup();
  const browser = findBrowser();
  await runtime.spawnDetached(
    process.platform === "darwin"
      ? { command: "/usr/bin/open", args: ["-b", browser, url] }
      : { command: browser, args: [url] },
  );
}
