module.exports = function (api) {
  api.cache(true);

  const expoPreset = [
    "babel-preset-expo",
    {
      // Transform `import.meta` for ALL platforms (web + native)
      // Required for modern ESM deps like Zustand 5 that use import.meta.env
      unstable_transformImportMeta: true,
    },
  ];

  return {
    presets: [expoPreset],
    plugins: [
      require.resolve("./scripts/babel-plugin-lucide-imports.cjs"),
      [
        "react-native-unistyles/plugin",
        {
          root: "src",
        },
      ],
    ],
  };
};
