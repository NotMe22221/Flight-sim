/**
 * Module Web Worker: fetch, decode and build scenery tiles off the main thread.
 * Created by loader.ts as `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.
 * Results transfer their ArrayBuffers (no copies).
 */
import { transferables, type WorkerRequest, type WorkerResponse } from './protocol';
import { handleRequest } from './workerCore';

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerResponse, transfer: Transferable[]): void;
};

scope.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (!req || req.type !== 'build') return;
  void handleRequest(req, (url) => fetch(url)).then((res) => {
    scope.postMessage(res, res.type === 'built' ? transferables(res.result) : []);
  });
};
