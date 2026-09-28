const fs = require("node:fs");
const path = require("node:path");

const stagingRoot = process.env.OMP_DESKTOP_WINDOWS_KEYRING_STAGING;
if (stagingRoot) {
  const nodeModulesRoot = path.resolve(__dirname, "..", "..", "..", "node_modules", "@napi-rs");
  for (const packageName of fs.readdirSync(stagingRoot)) {
    if (!/^keyring-win32-(?:x64|arm64)-msvc$/.test(packageName)) {
      throw new Error(`Unexpected staged Windows keyring package: ${packageName}`);
    }
    const source = path.join(stagingRoot, packageName);
    const destination = path.join(nodeModulesRoot, packageName);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: true });
    console.log(`Staged @napi-rs/${packageName} for electron-builder.`);
  }
}
