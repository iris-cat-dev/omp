const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const baseConfig = yaml.load(fs.readFileSync(path.join(__dirname, "electron-builder.yml"), "utf8"));

baseConfig.win.artifactName = "OMP-Desktop-No-OMP-Setup-${version}-${arch}.${ext}";
baseConfig.win.extraResources = baseConfig.win.extraResources.filter(
  (resource) => resource.to !== "bin/omp.exe",
);

module.exports = baseConfig;
