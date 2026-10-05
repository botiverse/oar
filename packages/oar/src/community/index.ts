/*
 * Community runtimes: contributed and maintained outside the OAR core team
 * (each one's maintainer is named on its docs/runtimes page). They are not
 * in the built-in `runtimes` registry; a host adds the ones it wants to
 * its own: `createRuntimeRegistry([...runtimes.list(), createMorphRuntime()])`.
 */
export { createMorphRuntime, morphBrand, projectMorphModels, type MorphRuntime } from "./morph/index.js";
