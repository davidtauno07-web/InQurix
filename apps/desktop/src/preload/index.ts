import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS, type EventChannel, type InvokeChannel } from '../shared/channels.js';

const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const eventAllowed = new Set<string>(EVENT_CHANNELS);

contextBridge.exposeInMainWorld('inqurix', {
  platform: process.platform,
  invoke: (channel: InvokeChannel, ...args: unknown[]) => {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`Blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: EventChannel, cb: (payload: unknown) => void) => {
    if (!eventAllowed.has(channel)) return () => undefined;
    const h = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
