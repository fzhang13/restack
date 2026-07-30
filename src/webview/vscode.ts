import type { WebviewMessage } from '../model';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** acquireVsCodeApi may only be called once per webview load. */
export const vscodeApi: VsCodeApi = acquireVsCodeApi();
