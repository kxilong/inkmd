import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join, extname } from 'node:path'
import { promises as fs } from 'node:fs'
import chokidar, { FSWatcher } from 'chokidar'

let win: BrowserWindow | null = null
let watcher: FSWatcher | null = null
let lastSelfWrite = 0

const MD_EXT = ['.md', '.markdown']

function fileFromArgv(argv: string[]): string | null {
  const f = argv.slice(1).find((a) => MD_EXT.includes(extname(a).toLowerCase()))
  return f ?? null
}

// 单实例：双击第二个 .md 时，交给已打开的窗口
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const f = fileFromArgv(argv)
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
      if (f) win.webContents.send('open-path', f)
    }
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'inkmd',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  const initial = fileFromArgv(process.argv)
  win.webContents.on('did-finish-load', () => {
    if (initial) win?.webContents.send('open-path', initial)
  })

  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))

  win.on('close', (e) => {
    // 交给渲染进程判断是否有未保存修改
    if (!(win as any).__forceClose) {
      e.preventDefault()
      win?.webContents.send('request-close')
    }
  })

  buildMenu()
}

function send(ch: string) {
  win?.webContents.send('menu', ch)
}

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: () => send('open-file') },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('open-folder') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '切换侧边栏', accelerator: 'CmdOrCtrl+\\', click: () => send('toggle-sidebar') },
        { label: '源码模式', accelerator: 'CmdOrCtrl+/', click: () => send('toggle-source') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '检查更新…', click: () => checkForUpdates(true) },
        { label: `关于 inkmd v${app.getVersion()}`, enabled: false }
      ]
    }
  ])
  Menu.setApplicationMenu(menu)
}

// ---------- IPC ----------
ipcMain.handle('dialog:openFile', async () => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
  })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('dialog:openFolder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('dialog:saveAs', async (_e, defaultPath?: string) => {
  const r = await dialog.showSaveDialog(win!, {
    defaultPath: defaultPath ?? 'untitled.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  return r.canceled ? null : r.filePath
})

ipcMain.handle('dialog:confirmDiscard', async () => {
  const r = await dialog.showMessageBox(win!, {
    type: 'warning',
    buttons: ['保存', '不保存', '取消'],
    defaultId: 0,
    cancelId: 2,
    message: '当前文件有未保存的修改，要保存吗？'
  })
  return (['save', 'discard', 'cancel'] as const)[r.response]
})

ipcMain.handle('fs:read', (_e, p: string) => fs.readFile(p, 'utf-8'))

ipcMain.handle('fs:write', async (_e, p: string, content: string) => {
  lastSelfWrite = Date.now()
  await fs.writeFile(p, content, 'utf-8')
})

type TreeNode = { name: string; path: string; children?: TreeNode[] }

async function readTree(dir: string, depth = 0): Promise<TreeNode[]> {
  if (depth > 6) return []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const nodes: TreeNode[] = []
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const children = await readTree(p, depth + 1)
      if (children.length) nodes.push({ name: e.name, path: p, children })
    } else if (MD_EXT.includes(extname(e.name).toLowerCase())) {
      nodes.push({ name: e.name, path: p })
    }
  }
  return nodes.sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name))
}

ipcMain.handle('fs:tree', (_e, dir: string) => readTree(dir))

ipcMain.handle('fs:watch', async (_e, p: string | null) => {
  await watcher?.close()
  watcher = null
  if (!p) return
  watcher = chokidar.watch(p, { ignoreInitial: true })
  watcher.on('change', () => {
    if (Date.now() - lastSelfWrite < 1000) return // 忽略自己保存触发的变化
    win?.webContents.send('file-changed', p)
  })
})

ipcMain.on('app:setTitle', (_e, t: string) => win?.setTitle(t))
ipcMain.on('app:forceClose', () => {
  if (win) {
    ;(win as any).__forceClose = true
    win.close()
  }
})

// ---------- 检查更新（只提示，不自动下载） ----------
const RELEASES_API = 'https://api.github.com/repos/kxilong/inkmd/releases/latest'

function isNewer(latest: string, current: string) {
  const a = latest.replace(/^v/, '').split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

async function checkForUpdates(manual: boolean) {
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const rel = (await res.json()) as { tag_name: string; html_url: string; body?: string }
    if (isNewer(rel.tag_name, app.getVersion())) {
      const r = await dialog.showMessageBox(win!, {
        type: 'info',
        buttons: ['去下载', '以后再说'],
        defaultId: 0,
        cancelId: 1,
        title: '发现新版本',
        message: `发现新版本 ${rel.tag_name}（当前 v${app.getVersion()}）`,
        detail: rel.body?.slice(0, 500) || '前往下载页面获取最新安装包。'
      })
      if (r.response === 0) shell.openExternal(rel.html_url)
    } else if (manual) {
      dialog.showMessageBox(win!, { type: 'info', message: `已是最新版本 v${app.getVersion()}` })
    }
  } catch (err) {
    if (manual) dialog.showMessageBox(win!, { type: 'error', message: '检查更新失败', detail: String(err) })
  }
}

app.whenReady().then(() => {
  createWindow()
  // 启动 3 秒后静默检查一次，有新版才弹窗
  if (app.isPackaged) setTimeout(() => checkForUpdates(false), 3000)
})
app.on('window-all-closed', () => app.quit())
