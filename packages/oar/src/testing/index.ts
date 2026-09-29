/**
 * Test support for hosts: runtimes that need no binary, login or provider but
 * produce a real `Session` (the same record stream, folds and control
 * semantics). Node-only, like the root entry.
 */
export { scriptedRuntime } from "./scripted-runtime.js";
export type { ScriptedAnswer, ScriptedQuestion, ScriptedRuntimeOptions, ScriptedTurn } from "./scripted-runtime.js";
