import { ipcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { IPCResult } from './contract.js';

export function registerTypedHandler<TReq, TRes>(
  channel: string,
  chromeWebContents: () => WebContents | null,
  handler: (req: TReq, event: IpcMainInvokeEvent) => Promise<TRes> | TRes
): void {
  ipcMain.handle(channel, async (event, req: TReq): Promise<IPCResult<TRes>> => {
    try {
      const chrome = chromeWebContents();
      if (!chrome || event.sender !== chrome) {
        return {
          ok: false,
          error: `Access denied: IPC on channel ${channel} rejected from unauthorized sender.`
        };
      }

      const data = await handler(req, event);
      return { ok: true, data };
    } catch (err: any) {
      console.error(`[IPC Error] Channel ${channel}:`, err);
      return {
        ok: false,
        error: err?.message || String(err)
      };
    }
  });
}
