// ponytail: TS 7 (native) ships no classic JS compiler API, but typescript-eslint
// (latest 8.72.1, peer typescript <6.1.0) needs it. The project compiles with
// TS 7; only the lint parser stack gets TS 6.0.3, as a pinned dependency in
// place of its peer. Delete this file once typescript-eslint supports TS 7
// (tracked in docs/UPGRADES.md).
const LINT_TS = "6.0.3";
const needsClassicApi = (name = "") =>
  name === "typescript-eslint" ||
  name === "ts-api-utils" ||
  name.startsWith("@typescript-eslint/");

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (needsClassicApi(pkg.name) && pkg.peerDependencies?.typescript) {
        delete pkg.peerDependencies.typescript;
        pkg.dependencies = { ...pkg.dependencies, typescript: LINT_TS };
      }
      return pkg;
    },
  },
};
