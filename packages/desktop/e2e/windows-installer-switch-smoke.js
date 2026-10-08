const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { UUID } = require("builder-util-runtime");
const { smokePackagedDesktopApp } = require("./packaged-app-smoke.js");

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 300_000,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${executable} failed (${result.status}): ${result.error || result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

async function checksum(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function install(installer, appPath) {
  // NSIS requires /D to be last and unquoted, including when it contains spaces.
  run(installer, ["/S", "/currentuser", `/D=${appPath}`], { windowsVerbatimArguments: true });
  assert.ok(fs.existsSync(path.join(appPath, "OMP Desktop.exe")), "Desktop was not installed");
}

function uninstall(appPath, root) {
  const installedUninstaller = path.join(appPath, "Uninstall OMP Desktop.exe");
  if (!fs.existsSync(installedUninstaller)) return;
  const uninstaller = path.join(root, "uninstall.exe");
  fs.copyFileSync(installedUninstaller, uninstaller);
  // Run outside INSTDIR and suppress self-copying so the process is awaited.
  run(uninstaller, ["/S", "/currentuser", `_?=${appPath}`], { windowsVerbatimArguments: true });
}

async function smokeWindowsInstallerSwitch({ standard, noOmp }) {
  if (process.platform !== "win32") throw new Error("This smoke requires a real Windows machine");
  for (const installer of [standard, noOmp]) fs.accessSync(installer);

  const config = require("js-yaml").load(
    fs.readFileSync(path.join(__dirname, "../electron-builder.yml"), "utf8"),
  );
  const guid = UUID.v5(config.appId, UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3"));
  for (const hive of ["HKCU", "HKLM"]) {
    const existing = spawnSync("reg.exe", ["query", `${hive}\\Software\\${guid}`, "/reg:64"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (existing.error) throw existing.error;
    if (existing.status === 0) {
      throw new Error("An existing Desktop installation is registered; use a clean Windows VM");
    }
    if (existing.status !== 1) throw new Error(`Unable to inspect ${hive}: ${existing.stderr}`);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-installer-switch-"));
  const originalPath = path.join(root, "original", "OMP Desktop 中文");
  const movedPath = path.join(root, "moved", "OMP Desktop 中文");
  let activePath = originalPath;
  const ompPath = (appPath) => path.join(appPath, "resources", "bin", "omp.exe");
  try {
    install(noOmp, activePath);
    assert.equal(fs.existsSync(ompPath(activePath)), false, "Fresh no-OMP install bundled OMP");
    uninstall(activePath, root);
    console.log("Installer switch smoke: fresh no-OMP installation has no bundled runtime");

    install(standard, activePath);
    const originalChecksum = await checksum(ompPath(activePath));
    const originalVersion = run(ompPath(activePath), ["--version"]);
    console.log(`Installer switch smoke: standard installer runtime ${originalVersion}`);

    install(noOmp, activePath);
    assert.equal(
      await checksum(ompPath(activePath)),
      originalChecksum,
      "Switch deleted/changed OMP",
    );
    assert.equal(run(ompPath(activePath), ["--version"]), originalVersion);
    await smokePackagedDesktopApp({ appPath: activePath });
    console.log(
      "Installer switch smoke: standard → no-OMP preserves exact runtime and starts Desktop",
    );

    activePath = movedPath;
    install(noOmp, activePath);
    assert.equal(await checksum(ompPath(activePath)), originalChecksum, "Relocation changed OMP");
    await smokePackagedDesktopApp({ appPath: activePath });
    console.log(
      "Installer switch smoke: repeated no-OMP install preserves runtime across relocation",
    );

    install(standard, activePath);
    assert.equal(await checksum(ompPath(activePath)), originalChecksum);
    console.log("Installer switch smoke: switching back to the standard installer succeeds");
  } finally {
    uninstall(activePath, root);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { smokeWindowsInstallerSwitch };

if (require.main === module) {
  const argument = (name) => {
    const index = process.argv.indexOf(name);
    if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name} installer path`);
    return path.resolve(process.argv[index + 1]);
  };
  Promise.resolve()
    .then(() =>
      smokeWindowsInstallerSwitch({
        standard: argument("--standard"),
        noOmp: argument("--no-omp"),
      }),
    )
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
