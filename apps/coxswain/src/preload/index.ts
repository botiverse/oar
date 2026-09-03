import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  parseAbortReceipt,
  parseFleetSnapshot,
  parseInspectResult,
  parseLaunchFleetRequest,
  parseLaunchRequest,
  parseLaneRequest,
  parseSessionIdentity,
  parseSubmitRequest,
  parseSubmitReceipt,
  parseUsageResult,
  type CoxswainApi,
  type HostEvent,
  type LaunchRequest,
  type SubmitRequest,
} from "../shared/ipc.js";

const api: CoxswainApi = {
  async inspect() {
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.inspect);
    return parseInspectResult(result);
  },
  async readUsage(runtimeId: string) {
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.usage, runtimeId);
    return parseUsageResult(result);
  },
  async launch(request: LaunchRequest) {
    const parsed = parseLaunchRequest(request);
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.launch, parsed);
    return parseSessionIdentity(result);
  },
  async launchFleet(request) {
    const parsed = parseLaunchFleetRequest(request);
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.launchFleet, parsed);
    if (!Array.isArray(result)) {
      throw new TypeError("launch fleet response must be an array");
    }
    return result.map((value) => parseSessionIdentity(value));
  },
  async fleet() {
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.fleet);
    return parseFleetSnapshot(result);
  },
  async submit(request: SubmitRequest) {
    const parsed = parseSubmitRequest(request);
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.submit, parsed);
    return parseSubmitReceipt(result);
  },
  async abort(request) {
    const parsed = request === undefined ? undefined : parseLaneRequest(request);
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.abort, parsed);
    return parseAbortReceipt(result);
  },
  async closeLane(request) {
    await ipcRenderer.invoke(IPC_CHANNELS.closeLane, parseLaneRequest(request));
  },
  async rendererReady() {
    await ipcRenderer.invoke(IPC_CHANNELS.rendererReady);
  },
  onHostEvent(listener: (event: HostEvent) => void): (() => void) {
    const receive = (_event: Electron.IpcRendererEvent, hostEvent: HostEvent): void => {
      listener(hostEvent);
    };
    ipcRenderer.on(IPC_CHANNELS.event, receive);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.event, receive);
    };
  },
};

contextBridge.exposeInMainWorld("coxswain", api);
