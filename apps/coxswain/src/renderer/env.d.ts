/// <reference types="vite/client" />

import type { CoxswainApi } from "../shared/ipc.js";

declare global {
  interface Window {
    readonly coxswain: CoxswainApi;
  }
}
