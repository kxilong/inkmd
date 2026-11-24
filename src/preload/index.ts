import { contextBridge, ipcRenderer } from 'electron'

const api = {
  openFileDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFile'),
  openFolderDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
  saveAsDialog: (p?: string): Promise<string | null> => ipcRenderer.invoke('dialog:saveAs', p),
  confirmDiscard: (): Promise<'save' | 'discard' | 'cancel'> => ipcRenderer.invoke('dialog:confirmDiscard'),
  readFile: (p: string): Promise<string> => ipcRenderer.invoke('fs:read', p),
  writeFile: (p: string, c: string): Promise<void> => ipcRenderer.invoke('fs:write', p, c),
  readTree: (dir: string) => ipcRenderer.invoke('fs:tree', dir),
  watch: (p: string | null) => ipcRenderer.invoke('fs:watch', p),
  setTitle: (t: string) => ipcRenderer.send('app:setTitle', t),
  forceClose: () => ipcRenderer.send('app:forceClose'),
  on: (ch: 'menu' | 'open-path' | 'file-changed' | 'request-close', cb: (arg?: any) => void) =>
    ipcRenderer.on(ch, (_e, arg) => cb(arg))
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
