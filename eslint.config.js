// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "dist", "eslint.config.js"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Chapter 1 rule: no casts on the contract boundary. A cast silences the
      // one checker that would have caught the bug that motivated this project.
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      // Chapter 1 rule: events are an exhaustive discriminated union, so a new
      // kind breaks the build for every consumer that ignores it.
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // A non-null assertion is a cast wearing a shorter name.
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
);
