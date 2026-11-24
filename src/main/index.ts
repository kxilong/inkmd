import { app, BrowserWindow, dialog, ipcMain, Menu, shell, protocol, net, nativeTheme } from 'electron'
import { join, extname, dirname, basename, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { marked } from 'marked'
import { promises as fs } from 'node:fs'
import chokidar, { FSWatcher } from 'chokidar'
import electronUpdater from 'electron-updater'
const { autoUpdater } = electronUpdater

let win: BrowserWindow | null = null
let watcher: FSWatcher | null = null
let lastSelfWrite = 0

const MD_EXT = ['.md', '.markdown']

// localfile://local/C:/path/to/img.png -> 读取本地文件（dev 和打包后都能显示相对路径图片）
protocol.registerSchemesAsPrivileged([
  { scheme: 'localfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff',
    autoHideMenuBar: false,
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
        { label: '新建标签', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: () => send('open-file') },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('open-folder') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
        { type: 'separator' },
        { label: '导出 HTML…', click: () => send('export-html') },
        { label: '导出 PDF…', accelerator: 'CmdOrCtrl+P', click: () => send('export-pdf') },
        { type: 'separator' },
        { label: '关闭标签', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
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
        { label: '文件 / 大纲', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('toggle-outline') },
        { label: '暗色主题', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('toggle-theme') },
        { label: '下一个标签', accelerator: 'Ctrl+Tab', click: () => send('next-tab') },
        { label: '上一个标签', accelerator: 'Ctrl+Shift+Tab', click: () => send('prev-tab') },
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

// 监听所有打开的标签对应的文件
ipcMain.handle('fs:watch', async (_e, paths: string[]) => {
  await watcher?.close()
  watcher = null
  if (!paths.length) return
  watcher = chokidar.watch(paths, { ignoreInitial: true })
  watcher.on('change', (p) => {
    if (Date.now() - lastSelfWrite < 1000) return // 忽略自己保存触发的变化
    win?.webContents.send('file-changed', p)
  })
})

// 粘贴图片：存到 md 同级 assets/ 下，返回相对路径
ipcMain.handle('fs:saveImage', async (_e, docPath: string, data: ArrayBuffer, ext: string) => {
  const dir = join(dirname(docPath), 'assets')
  await fs.mkdir(dir, { recursive: true })
  const name = `image-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}.${ext}`
  await fs.writeFile(join(dir, name), Buffer.from(data))
  return `assets/${name}`
})

// ---------- 导出 ----------
function toHtmlDoc(md: string, title: string, docPath: string | null) {
  let body = marked.parse(md, { async: false }) as string
  if (docPath) {
    // 相对图片改成绝对 file:// 路径，导出后也能显示
    body = body.replace(/(<img[^>]+src=")([^"]+)"/g, (m, pre, src) => {
      if (/^(https?:|data:|file:)/.test(src)) return m
      const abs = isAbsolute(src) ? src : join(dirname(docPath), decodeURI(src))
      return `${pre}${pathToFileURL(abs).href}"`
    })
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>
body{max-width:860px;margin:40px auto;padding:0 24px;font:16px/1.75 'Segoe UI','Microsoft YaHei',sans-serif;color:#222}
h1,h2{border-bottom:1px solid #eee;padding-bottom:.3em}
pre{background:#f6f8fa;padding:14px;border-radius:6px;overflow:auto}
code{font-family:Consolas,'Cascadia Code',monospace;font-size:.9em}
:not(pre)>code{background:#f0f0f0;padding:2px 5px;border-radius:4px}
blockquote{margin:0;padding:0 1em;color:#666;border-left:4px solid #ddd}
table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:6px 12px}
img{max-width:100%}
@media print{body{margin:0}pre{white-space:pre-wrap}}
</style></head><body>${body}</body></html>`
}

ipcMain.handle('export', async (_e, kind: 'html' | 'pdf', md: string, docPath: string | null) => {
  const base = docPath ? basename(docPath).replace(/\.(md|markdown)$/i, '') : 'untitled'
  const r = await dialog.showSaveDialog(win!, {
    defaultPath: join(docPath ? dirname(docPath) : app.getPath('documents'), `${base}.${kind}`),
    filters: [{ name: kind.toUpperCase(), extensions: [kind] }]
  })
  if (r.canceled || !r.filePath) return false
  const html = toHtmlDoc(md, base, docPath)
  if (kind === 'html') {
    await fs.writeFile(r.filePath, html, 'utf-8')
  } else {
    const tmp = join(app.getPath('temp'), `inkmd-export-${Date.now()}.html`)
    await fs.writeFile(tmp, html, 'utf-8')
    const pdfWin = new BrowserWindow({ show: false })
    await pdfWin.loadFile(tmp)
    const pdf = await pdfWin.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    pdfWin.destroy()
    await fs.writeFile(r.filePath, pdf)
    fs.unlink(tmp).catch(() => {})
  }
  shell.showItemInFolder(r.filePath)
  return true
})

// 让 Windows 标题栏、菜单栏跟随软件主题（亮色时是白色标题栏，和 Typora 一致）
ipcMain.on('theme:set', (_e, t: 'dark' | 'light') => {
  nativeTheme.themeSource = t
  win?.setBackgroundColor(t === 'dark' ? '#1f1f1f' : '#ffffff')
})

ipcMain.handle('theme:system', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))

ipcMain.on('app:setTitle', (_e, t: string) => win?.setTitle(t))
ipcMain.on('app:forceClose', () => {
  if (win) {
    ;(win as any).__forceClose = true
    win.close()
  }
})

// ---------- 软件内更新：用户点「立即更新」才下载，下完由用户点「重启安装」 ----------
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false

let updateState: 'idle' | 'checking' | 'downloading' | 'ready' = 'idle'
let installOnClose = false
let readyVersion = ''

function updateStatus(text: string) {
  win?.webContents.send('update-status', text)
}

function notesText(n: unknown): string {
  if (!n) return ''
  const raw = Array.isArray(n) ? n.map((x: any) => x.note ?? '').join('\n') : String(n)
  return raw.replace(/<[^>]+>/g, '').trim().slice(0, 500)
}

autoUpdater.on('download-progress', (p) => {
  win?.setProgressBar(p.percent / 100)
  updateStatus(`正在下载更新 ${Math.floor(p.percent)}%`)
})

async function askInstall(version: string) {
  updateState = 'ready'
  readyVersion = version
  win?.setProgressBar(-1)
  updateStatus(`新版本 v${version} 已下载`)
  const r = await dialog.showMessageBox(win!, {
    type: 'info',
    buttons: ['重启安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
    title: '更新已就绪',
    message: `v${version} 已下载完成`,
    detail: '点「重启安装」会关闭 inkmd 并安装新版本，未保存的文档会先询问你。选「稍后」可以在帮助菜单里再次安装。'
  })
  if (r.response === 0) {
    installOnClose = true
    win?.close() // 走正常关闭流程（未保存会提示），窗口真正关闭后再安装
  }
}

async function checkForUpdates(manual: boolean) {
  if (!app.isPackaged) {
    if (manual) dialog.showMessageBox(win!, { type: 'info', message: '开发模式下不检查更新' })
    return
  }
  if (updateState === 'downloading') {
    if (manual) dialog.showMessageBox(win!, { type: 'info', message: '正在下载更新，请稍候' })
    return
  }
  if (updateState === 'ready') {
    return askInstall(readyVersion)
  }
  if (updateState === 'checking') return
  updateState = 'checking'
  try {
    const res = await autoUpdater.checkForUpdates()
    const info = res?.updateInfo
    if (info && isNewer(info.version, app.getVersion())) {
      updateState = 'idle'
      const r = await dialog.showMessageBox(win!, {
        type: 'info',
        buttons: ['立即更新', '以后再说'],
        defaultId: 0,
        cancelId: 1,
        title: '发现新版本',
        message: `发现新版本 v${info.version}（当前 v${app.getVersion()}）`,
        detail: notesText(info.releaseNotes) || '点「立即更新」在软件内下载，下完后提示你重启安装。'
      })
      if (r.response !== 0) return
      updateState = 'downloading'
      updateStatus('正在下载更新…')
      await autoUpdater.downloadUpdate()
      await askInstall(info.version)
    } else {
      updateState = 'idle'
      if (manual) dialog.showMessageBox(win!, { type: 'info', message: `已是最新版本 v${app.getVersion()}` })
    }
  } catch (err) {
    const wasDownloading = updateState === 'downloading'
    updateState = 'idle'
    win?.setProgressBar(-1)
    updateStatus('')
    if (!manual && !wasDownloading) return
    const r = await dialog.showMessageBox(win!, {
      type: 'error',
      buttons: ['去下载页', '关闭'],
      defaultId: 0,
      cancelId: 1,
      message: wasDownloading ? '下载更新失败' : '检查更新失败',
      detail: String(err)
    })
    if (r.response === 0) shell.openExternal(RELEASES_PAGE)
  }
}

const RELEASES_PAGE = 'https://github.com/kxilong/inkmd/releases/latest'

function isNewer(latest: string, current: string) {
  const a = latest.replace(/^v/, '').split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

app.whenReady().then(() => {
  protocol.handle('localfile', (req) => {
    const url = new URL(req.url)
    const p = decodeURIComponent(url.pathname.replace(/^\//, ''))
    return net.fetch(pathToFileURL(p).href)
  })
  createWindow()
  // 启动 3 秒后静默检查一次，有新版才弹窗
  if (app.isPackaged) setTimeout(() => checkForUpdates(false), 3000)
})
app.on('window-all-closed', () => {
  if (installOnClose) autoUpdater.quitAndInstall(true, true) // 静默安装后自动重新打开
  else app.quit()
})
