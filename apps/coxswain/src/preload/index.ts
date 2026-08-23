import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  parseAbortReceipt,
  parseInspectResult,
  parseSessionIdentity,
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
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.launch, request);
    return parseSessionIdentity(result);
  },
  async submit(request: SubmitRequest) {
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.submit, request);
    return parseSubmitReceipt(result);
  },
  async abort() {
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.abort);
    return parseAbortReceipt(result);
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
