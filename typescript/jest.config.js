export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^fastly:.*$": "<rootDir>/src/__mocks__/fastly.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true }],
  },
  testMatch: ["<rootDir>/src/**/*.test.ts"],
  // Coverage gate applies to the pure modules. Handlers, templates, and the
  // Fastly hostcall wrappers (kv, logging, ratelimit, cache, security wiring)
  // need the Compute runtime; they are exercised by Viceroy smoke tests and
  // the repo-level integration suite instead.
  collectCoverageFrom: [
    "src/validation.ts",
    "src/forms.ts",
    "src/auth.ts",
    "src/csrf.ts",
    "src/sanitize.ts",
    "src/markdown.ts",
    "src/dates.ts",
    "src/pagination.ts",
    "src/privacy.ts",
    "src/sidebar.ts",
    "src/models.ts",
    "src/router.ts",
    "src/seo.ts",
  ],
  coverageThreshold: {
    global: { lines: 80, statements: 80, functions: 80, branches: 70 },
  },
};
