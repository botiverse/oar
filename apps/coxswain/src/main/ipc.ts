import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import {
  IPC_CHANNELS,
  parseLaneRequest,
  parseLaunchFleetRequest,
  parseLaunchRequest,
  parseRuntimeId,
  parseSubmitRequest,
  type HostEvent,
} from "../shared/ipc.js";
import type { AgentHost } from "./agent.js";

export interface RegisterIpcOptions {
  readonly host: AgentHost;
  readonly webContents: WebContents;
  readonly onRendererReady: () => void;
}

function assertTrustedSender(event: IpcMainInvokeEvent, webContents: WebContents): void {
  if (event.sender.id !== webContents.id) {
    throw new Error("Rejected IPC from an unknown renderer");
  }
}

export function registerIpc(options: RegisterIpcOptions): () => void {
  const forward = (event: HostEvent): void => {
    if (!options.webContents.isDestroyed()) {
      options.webContents.send(IPC_CHANNELS.event, event);
    }
  };
  const unsubscribe = options.host.subscribe(forward);

  ipcMain.handle(IPC_CHANNELS.inspect, async (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event, options.webContents);
    return options.host.inspect();
  });
  ipcMain.handle(
    IPC_CHANNELS.usage,
    async (event: IpcMainInvokeEvent, runtimeId: unknown) => {
      assertTrustedSender(event, options.webContents);
      return options.host.readUsage(parseRuntimeId(runtimeId));
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.launch,
    async (event: IpcMainInvokeEvent, request: unknown) => {
      assertTrustedSender(event, options.webContents);
      return options.host.launch(parseLaunchRequest(request));
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.launchFleet,
    async (event: IpcMainInvokeEvent, request: unknown) => {
      assertTrustedSender(event, options.webContents);
      return options.host.launchFleet(parseLaunchFleetRequest(request));
    },
  );
  ipcMain.handle(IPC_CHANNELS.fleet, (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event, options.webContents);
    return options.host.fleet();
  });
  ipcMain.handle(
    IPC_CHANNELS.submit,
    async (event: IpcMainInvokeEvent, request: unknown) => {
      assertTrustedSender(event, options.webContents);
      const parsed = parseSubmitRequest(request);
      return options.host.submit(parsed.text, parsed.laneId);
    },
  );
  ipcMain.handle(IPC_CHANNELS.abort, async (event: IpcMainInvokeEvent, request: unknown) => {
    assertTrustedSender(event, options.webContents);
    return options.host.abort(request === undefined ? undefined : parseLaneRequest(request).laneId);
  });
  ipcMain.handle(IPC_CHANNELS.closeLane, async (event: IpcMainInvokeEvent, request: unknown) => {
    assertTrustedSender(event, options.webContents);
    await options.host.closeLane(parseLaneRequest(request).laneId);
  });
  ipcMain.handle(IPC_CHANNELS.rendererReady, async (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event, options.webContents);
    options.onRendererReady();
  });

  return () => {
    unsubscribe();
    ipcMain.removeHandler(IPC_CHANNELS.inspect);
    ipcMain.removeHandler(IPC_CHANNELS.usage);
    ipcMain.removeHandler(IPC_CHANNELS.launch);
    ipcMain.removeHandler(IPC_CHANNELS.launchFleet);
    ipcMain.removeHandler(IPC_CHANNELS.fleet);
    ipcMain.removeHandler(IPC_CHANNELS.submit);
    ipcMain.removeHandler(IPC_CHANNELS.abort);
    ipcMain.removeHandler(IPC_CHANNELS.closeLane);
    ipcMain.removeHandler(IPC_CHANNELS.rendererReady);
  };
}
