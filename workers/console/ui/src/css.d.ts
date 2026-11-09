// Vite bundles CSS imported for its side effect (main.tsx imports ./index.css). TypeScript 6+
// checks side-effect imports (noUncheckedSideEffectImports defaults to true), so declare them.
declare module "*.css";
