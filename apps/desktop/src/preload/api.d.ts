import type { EventChannel, InvokeChannel } from '../shared/channels';
declare global {
  interface Window {
    inqurix: {
      platform: string;
      invoke<T = unknown>(channel: InvokeChannel, ...args: unknown[]): Promise<T>;
      on(channel: EventChannel, cb: (payload: unknown) => void): () => void;
    };
  }
}
export {};
