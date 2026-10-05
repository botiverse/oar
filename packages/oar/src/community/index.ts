/*
 * Community runtimes: contributed and maintained outside the OAR core team
 * (each one's maintainer is named on its docs/runtimes page). They are not
 * in `defaultRuntimes`; a host adds the ones it wants to its own:
 * `createRuntimeRegistry([...defaultRuntimes.list(), createMorphRuntime()])`.
 */
export { createMorphRuntime, morphBrand, projectMorphModels, type MorphRuntime } from "./morph/index.js";
