const fs = require("node:fs");
const path = require("node:path");

const packageName = "lucide-react-native";
let runtimeExports;

module.exports = function ({ template, types: t }) {
  function getRuntimeExports() {
    if (runtimeExports) return runtimeExports;

    const packageFile = require.resolve(`${packageName}/package.json`);
    const packageInfo = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    const entry = packageInfo.module;
    if (!entry) throw new Error(`${packageName} must provide an ESM entry point`);

    // Read Lucide's own declarations: legacy aliases and digits do not follow
    // a reliable PascalCase-to-filename convention. Keep its licensed modules intact.
    const declarations = template.ast(
      fs.readFileSync(path.resolve(path.dirname(packageFile), entry), "utf8"),
      { syntacticPlaceholders: false, placeholderPattern: false },
    );
    const exports = new Map();
    for (const declaration of Array.isArray(declarations) ? declarations : [declarations]) {
      if (!t.isExportNamedDeclaration(declaration) || !declaration.source) continue;
      const source = path.posix.join(
        packageName,
        path.posix.dirname(entry),
        declaration.source.value,
      );
      for (const specifier of declaration.specifiers) {
        if (!t.isExportSpecifier(specifier)) continue;
        exports.set(specifier.exported.name ?? specifier.exported.value, {
          source,
          imported: specifier.local.name ?? specifier.local.value,
        });
      }
    }
    runtimeExports = exports;
    return runtimeExports;
  }

  return {
    name: "selective-lucide-react-native-imports",
    visitor: {
      ImportDeclaration(importPath) {
        const declaration = importPath.node;
        if (declaration.source.value !== packageName || declaration.importKind === "type") return;
        if (declaration.specifiers.length === 0) {
          throw importPath.buildCodeFrameError(
            "Use named Lucide imports, not the full icon barrel.",
          );
        }
        if (declaration.specifiers.every((specifier) => specifier.importKind === "type")) return;

        const imports = [];
        const typeSpecifiers = [];
        for (const specifier of declaration.specifiers) {
          if (specifier.importKind === "type") {
            typeSpecifiers.push(specifier);
            continue;
          }
          if (!t.isImportSpecifier(specifier)) {
            throw importPath.buildCodeFrameError(
              "Use named Lucide imports instead of default/namespace imports.",
            );
          }
          const name = specifier.imported.name ?? specifier.imported.value;
          const target = getRuntimeExports().get(name);
          if (!target) {
            throw importPath.buildCodeFrameError(
              `Lucide export ${name} has no direct ESM module; use a named icon or an explicit type import.`,
            );
          }
          const binding =
            target.imported === "default"
              ? t.importDefaultSpecifier(t.cloneNode(specifier.local))
              : t.importSpecifier(t.cloneNode(specifier.local), t.identifier(target.imported));
          imports.push(t.importDeclaration([binding], t.stringLiteral(target.source)));
        }
        // Source types continue resolving against Lucide's public .d.ts exports.
        // Babel's TypeScript transform erases this declaration before Metro sees it.
        if (typeSpecifiers.length) {
          imports.push(t.importDeclaration(typeSpecifiers, t.stringLiteral(packageName)));
        }
        importPath.replaceWithMultiple(imports);
      },
    },
  };
};
