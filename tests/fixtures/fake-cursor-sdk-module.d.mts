import type { CursorSdk } from "../../packages/oar/src/runtimes/cursor/sdk.js";

/* The types of fake-cursor-sdk-module.mjs, so a test can also hand it over in process. */
export declare const FAKE_KEY: string;
export declare const FAKE_LOGIN_URL: string;
export declare const Agent: CursorSdk["Agent"];
export declare const Cursor: CursorSdk["Cursor"];
export declare const FileCredentialStore: NonNullable<CursorSdk["FileCredentialStore"]>;
