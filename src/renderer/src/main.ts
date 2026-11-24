import { Crepe } from '@milkdown/crepe'
import { insert } from '@milkdown/kit/utils'
import { editorViewCtx } from '@milkdown/kit/core'
import '@milkdown/crepe/theme/common/style.css'
import lightTheme from '@milkdown/crepe/theme/frame.css?url'
import darkTheme from '@milkdown/crepe/theme/frame-dark.css?url'
import './style.css'
import './typora.css'

type TreeNode = { name: string; path: string; children?: TreeNode[] }
type Tab = { id: number; path: string | null; saved: string; content: string; fresh: boolean; scroll: number }

const api = window.api
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const mainEl = $('main')
const editorEl = $('editor')
const sourceEl = $<HTMLTextAreaElement>('source')
const treeEl = $('tree')
const outlineEl = $('outline')
const tabbarEl = $('tabbar')

const WELCOME = '# 欢迎使用 inkmd\n\n直接开始写，或者用 `Ctrl+O` 打开文件、`Ctrl+Shift+O` 打开文件夹。\n'

let tabSeq = 0
const tabs: Tab[] = []
let active!: Tab
let folder: string | null = null
let sourceMode = false
let crepe: Crepe | null = null

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p
const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, '')

// ---------- 主题 ----------
async function applyTheme(theme: 'dark' | 'light') {
  document.body.classList.toggle('dark', theme === 'dark')
  $<HTMLLinkElement>('theme-css').href = theme === 'dark' ? darkTheme : lightTheme
  localStorage.setItem('theme', theme)
  api.setTheme(theme)
}
const savedTheme = localStorage.getItem('theme') as 'dark' | 'light' | null
// 默认亮色（Typora 风格），用户切换过就按用户的
applyTheme(savedTheme ?? 'light')

// ---------- 图片路径：相对路径 -> localfile:// ----------
function resolveImage(url: string): string {
  if (!url || /^(https?:|data:|blob:|localfile:)/i.test(url)) return url
  let abs: string
  if (/^file:/i.test(url)) return 'localfile://local/' + decodeURI(url.replace(/^file:\/+/i, ''))
  if (/^[a-zA-Z]:[\\/]/.test(url) || url.startsWith('\\\\')) abs = url
  else if (active.path) {
    const dir = dirname(active.path).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
    return new URL(url, `localfile://local/${dir}/`).href
  } else return url
  return 'localfile://local/' + abs.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
}

// 去掉文件开头的不可见字符（BOM、零宽空格、&nbsp; 行、空行），它们会在顶部显示成一个空段落
function normalizeMd(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/^[\uFEFF\u200B-\u200D]+/, '')
    .replace(/^(?:[ \t\u00A0\u200B-\u200D\uFEFF]*(?:&nbsp;|<br\s*\/?>)?[ \t\u00A0\u200B-\u200D]*\n)+/i, '')
}

// 编辑器里开头若还有空段落（且后面还有内容），删掉
function dropLeadingEmpty() {
  crepe?.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    const { doc } = view.state
    let end = 0
    for (let i = 0; i < doc.childCount - 1; i++) {
      const n = doc.child(i)
      let blank = n.type.name === 'paragraph' && n.textContent.replace(/[\s\uFEFF\u200B-\u200D\u00A0]/g, '') === ''
      n.forEach((c) => {
        if (!c.isText && c.type.name !== 'hardbreak') blank = false
      })
      if (!blank) break
      end += n.nodeSize
    }
    if (end > 0) view.dispatch(view.state.tr.delete(0, end).setMeta('addToHistory', false))
  })
}

// ---------- 编辑器 ----------
let outlineTimer = 0
async function mountEditor(markdown: string) {
  await crepe?.destroy()
  editorEl.innerHTML = ''
  crepe = new Crepe({
    root: editorEl,
    defaultValue: markdown,
    featureConfigs: {
      [Crepe.Feature.Placeholder]: { text: '开始输入…', mode: 'doc' },
      [Crepe.Feature.ImageBlock]: { proxyDomURL: resolveImage, onUpload: uploadImage }
    }
  })
  crepe.on((l) => {
    l.markdownUpdated((_ctx, md) => {
      active.content = md
      refreshUI()
      clearTimeout(outlineTimer)
      outlineTimer = window.setTimeout(renderOutline, 300)
    })
  })
  await crepe.create()
  dropLeadingEmpty()
  active.content = crepe.getMarkdown()
  renderOutline()
}

const currentMarkdown = () => (sourceMode ? sourceEl.value : crepe?.getMarkdown() ?? active.content)
const tabDirty = (t: Tab) => (t === active ? currentMarkdown() : t.content) !== t.saved

async function showTab(t: Tab) {
  if (active && active !== t) {
    active.content = currentMarkdown()
    active.scroll = sourceMode ? sourceEl.scrollTop : mainEl.scrollTop
  }
  active = t
  if (sourceMode) {
    sourceEl.value = t.content
    renderOutline()
  } else {
    await mountEditor(t.content)
  }
  if (t.fresh) {
    t.saved = currentMarkdown() // 以编辑器规范化后的内容为基准，避免一打开就显示“已修改”
    t.fresh = false
  }
  requestAnimationFrame(() => {
    if (sourceMode) sourceEl.scrollTop = t.scroll
    else mainEl.scrollTop = t.scroll
  })
  refreshUI()
  highlightActive()
}

function refreshUI() {
  const name = active.path ? basename(active.path) : '未命名'
  api.setTitle(`${tabDirty(active) ? '● ' : ''}${name} - inkmd`)
  $('status-path').textContent = active.path ?? '未命名'
  $('status-info').textContent = `${currentMarkdown().replace(/\s/g, '').length} 字`
  renderTabs()
}

// ---------- 标签页 ----------
function renderTabs() {
  tabbarEl.innerHTML = ''
  for (const t of tabs) {
    const el = document.createElement('div')
    el.className = 'tab' + (t === active ? ' on' : '')
    el.title = t.path ?? '未命名'
    const name = document.createElement('span')
    name.textContent = (t.path ? basename(t.path) : '未命名')
    const close = document.createElement('span')
    close.className = 'close'
    close.textContent = tabDirty(t) ? '●' : '×'
    close.onclick = (e) => {
      e.stopPropagation()
      closeTab(t)
    }
    el.append(name, close)
    el.onclick = () => t !== active && showTab(t)
    el.onauxclick = (e) => e.button === 1 && closeTab(t)
    tabbarEl.appendChild(el)
  }
  // 和 Typora 一样：只有一个文件时不显示标签栏
  tabbarEl.classList.toggle('single', tabs.length <= 1)
}

function newTab(init: Partial<Tab> = {}): Tab {
  const t: Tab = { id: ++tabSeq, path: null, saved: '', content: '', fresh: true, scroll: 0, ...init }
  tabs.push(t)
  return t
}

async function closeTab(t: Tab) {
  if (t !== active) await showTab(t)
  if (!(await confirmLeave(t))) return
  const i = tabs.indexOf(t)
  tabs.splice(i, 1)
  if (!tabs.length) newTab()
  await syncWatch()
  active = undefined as unknown as Tab
  await showTab(tabs[Math.min(i, tabs.length - 1)])
}

async function syncWatch() {
  await api.watch(tabs.filter((t) => t.path).map((t) => t.path!))
}

// ---------- 文件操作 ----------
async function confirmLeave(t: Tab): Promise<boolean> {
  if (!tabDirty(t)) return true
  const r = await api.confirmDiscard()
  if (r === 'cancel') return false
  if (r === 'save') return await save()
  return true
}

async function openPath(p: string) {
  const existing = tabs.find((t) => t.path === p)
  if (existing) return showTab(existing)
  const text = normalizeMd(await api.readFile(p))
  // 当前是没改动过的空白/欢迎页，就直接替换掉
  const reuse = !active.path && !tabDirty(active) && (active.content.trim() === '' || active.content === active.saved)
  if (reuse) Object.assign(active, { path: p, saved: text, content: text, fresh: true, scroll: 0 })
  const t = reuse ? active : newTab({ path: p, saved: text, content: text })
  if (reuse) active = undefined as unknown as Tab
  await showTab(t)
  await syncWatch()
}

async function save(): Promise<boolean> {
  if (!active.path) return saveAs()
  const md = currentMarkdown()
  await api.writeFile(active.path, md)
  active.saved = md
  active.content = md
  refreshUI()
  return true
}

async function saveAs(): Promise<boolean> {
  const p = await api.saveAsDialog(active.path ?? undefined)
  if (!p) return false
  active.path = p
  await save()
  await syncWatch()
  if (folder) loadFolder(folder)
  highlightActive()
  return true
}

async function exportDoc(kind: 'html' | 'pdf') {
  $('status-info').textContent = `正在导出 ${kind.toUpperCase()}…`
  await api.exportDoc(kind, currentMarkdown(), active.path)
  refreshUI()
}

// ---------- 粘贴 / 拖入图片 ----------
const IMG_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' }

async function uploadImage(file: File): Promise<string> {
  if (!active.path) {
    alert('请先保存文档，图片会存到文档同级的 assets 文件夹。')
    if (!(await saveAs())) return ''
  }
  const ext = IMG_EXT[file.type] ?? (file.name.split('.').pop() || 'png')
  return api.saveImage(active.path!, await file.arrayBuffer(), ext)
}

async function insertImages(files: File[]) {
  for (const f of files) {
    const rel = await uploadImage(f)
    if (!rel) return
    if (sourceMode) sourceEl.setRangeText(`![](${rel})`, sourceEl.selectionStart, sourceEl.selectionEnd, 'end')
    else crepe?.editor.action(insert(`![](${rel})`))
  }
  refreshUI()
}

function imageFiles(dt: DataTransfer | null): File[] {
  return Array.from(dt?.files ?? []).filter((f) => f.type.startsWith('image/'))
}

for (const el of [editorEl, sourceEl]) {
  el.addEventListener(
    'paste',
    (e) => {
      const imgs = imageFiles(e.clipboardData)
      if (!imgs.length) return
      e.preventDefault()
      e.stopImmediatePropagation()
      insertImages(imgs)
    },
    true
  )
}

// ---------- 源码模式 ----------
async function toggleSource() {
  if (sourceMode) {
    active.content = sourceEl.value
    sourceMode = false
    document.body.classList.remove('source-mode')
    sourceEl.hidden = true
    editorEl.hidden = false
    await mountEditor(active.content)
  } else {
    sourceEl.value = crepe?.getMarkdown() ?? active.content
    sourceMode = true
    document.body.classList.add('source-mode')
    editorEl.hidden = true
    sourceEl.hidden = false
    sourceEl.focus()
    renderOutline()
  }
  refreshUI()
}
sourceEl.addEventListener('input', () => {
  active.content = sourceEl.value
  refreshUI()
  clearTimeout(outlineTimer)
  outlineTimer = window.setTimeout(renderOutline, 300)
})
sourceEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault()
    sourceEl.setRangeText('  ', sourceEl.selectionStart, sourceEl.selectionEnd, 'end')
  }
})

// ---------- 大纲 ----------
function renderOutline() {
  outlineEl.innerHTML = ''
  type H = { level: number; text: string; go: () => void }
  const heads: H[] = []
  if (sourceMode) {
    const lines = sourceEl.value.split('\n')
    let inCode = false
    lines.forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) inCode = !inCode
      const m = !inCode && /^(#{1,6})\s+(.+)$/.exec(line)
      if (m)
        heads.push({
          level: m[1].length,
          text: m[2].replace(/[*_`]/g, ''),
          go: () => {
            const pos = lines.slice(0, i).join('\n').length + (i ? 1 : 0)
            sourceEl.focus()
            sourceEl.setSelectionRange(pos, pos)
            sourceEl.scrollTop = (i / lines.length) * sourceEl.scrollHeight - 40
          }
        })
    })
  } else {
    editorEl.querySelectorAll<HTMLElement>('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6').forEach((h) =>
      heads.push({ level: Number(h.tagName[1]), text: h.textContent ?? '', go: () => h.scrollIntoView({ behavior: 'smooth', block: 'start' }) })
    )
  }
  if (!heads.length) {
    outlineEl.innerHTML = '<div class="empty">没有标题</div>'
    return
  }
  const min = Math.min(...heads.map((h) => h.level))
  for (const h of heads) {
    const el = document.createElement('div')
    el.className = 'node heading h' + (h.level - min + 1)
    el.style.paddingLeft = `${16 + (h.level - min) * 14}px`
    el.textContent = h.text
    el.onclick = h.go
    outlineEl.appendChild(el)
  }
}

function showPanel(name: 'files' | 'outline') {
  document.body.classList.remove('no-sidebar')
  $('panel-files').hidden = name !== 'files'
  $('panel-outline').hidden = name !== 'outline'
  document.querySelectorAll<HTMLElement>('#side-tabs [data-panel]').forEach((b) => b.classList.toggle('on', b.dataset.panel === name))
  localStorage.setItem('panel', name)
}
document.querySelectorAll<HTMLElement>('#side-tabs [data-panel]').forEach((b) => (b.onclick = () => showPanel(b.dataset.panel as 'files' | 'outline')))
showPanel((localStorage.getItem('panel') as 'files' | 'outline') ?? 'files')

// ---------- 侧边栏目录树 ----------
async function loadFolder(dir: string) {
  folder = dir
  $('folder-name').textContent = basename(dir)
  const tree: TreeNode[] = await api.readTree(dir)
  treeEl.innerHTML = ''
  treeEl.appendChild(renderTree(tree))
  highlightActive()
  localStorage.setItem('folder', dir)
}

function renderTree(nodes: TreeNode[]): HTMLElement {
  const ul = document.createElement('ul')
  for (const n of nodes) {
    const li = document.createElement('li')
    const row = document.createElement('div')
    row.className = n.children ? 'node dir' : 'node file'
    row.textContent = (n.children ? '▾ ' : '') + n.name
    row.dataset.path = n.path
    li.appendChild(row)
    if (n.children) {
      const child = renderTree(n.children)
      li.appendChild(child)
      row.onclick = () => {
        child.hidden = !child.hidden
        row.textContent = (child.hidden ? '▸ ' : '▾ ') + n.name
      }
    } else {
      row.onclick = () => openPath(n.path)
    }
    ul.appendChild(li)
  }
  return ul
}

function highlightActive() {
  treeEl.querySelectorAll('.node.file').forEach((el) => {
    el.classList.toggle('active', (el as HTMLElement).dataset.path === active?.path)
  })
}

async function openFolder() {
  const dir = await api.openFolderDialog()
  if (dir) {
    await loadFolder(dir)
    showPanel('files')
  }
}
$('btn-open-folder').onclick = openFolder

// ---------- 拖拽 ----------
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener(
  'drop',
  (e) => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    const mds = files.map((f) => api.pathForFile(f)).filter((p) => /\.(md|markdown)$/i.test(p))
    const imgs = imageFiles(e.dataTransfer)
    if (!mds.length && !imgs.length) return
    e.preventDefault()
    e.stopImmediatePropagation()
    mds.forEach((p) => openPath(p))
    if (imgs.length) insertImages(imgs)
  },
  true
)

// ---------- 主进程事件 ----------
api.on('menu', async (cmd: string) => {
  switch (cmd) {
    case 'new': return showTab(newTab())
    case 'open-file': {
      const p = await api.openFileDialog()
      if (p) openPath(p)
      return
    }
    case 'open-folder': return openFolder()
    case 'save': return save()
    case 'save-as': return saveAs()
    case 'export-html': return exportDoc('html')
    case 'export-pdf': return exportDoc('pdf')
    case 'close-tab': return closeTab(active)
    case 'next-tab': return showTab(tabs[(tabs.indexOf(active) + 1) % tabs.length])
    case 'prev-tab': return showTab(tabs[(tabs.indexOf(active) - 1 + tabs.length) % tabs.length])
    case 'toggle-sidebar': return document.body.classList.toggle('no-sidebar')
    case 'toggle-outline': return showPanel($('panel-outline').hidden ? 'outline' : 'files')
    case 'toggle-theme': return applyTheme(document.body.classList.contains('dark') ? 'light' : 'dark')
    case 'toggle-source': return toggleSource()
  }
})

api.on('open-path', (p: string) => openPath(p))

api.on('file-changed', async (p: string) => {
  const t = tabs.find((x) => x.path === p)
  if (!t) return
  const text = normalizeMd(await api.readFile(p))
  if (text === t.saved) return
  if (t !== active) {
    if (!tabDirty(t)) Object.assign(t, { saved: text, content: text, fresh: true })
    return
  }
  if (tabDirty(t) && !confirm(`${basename(p)} 已在外部被修改，要重新加载并丢弃你的修改吗？`)) return
  t.content = text
  t.fresh = true
  const keep = t
  active = undefined as unknown as Tab
  await showTab(keep)
})

api.on('request-close', async () => {
  for (const t of [...tabs]) {
    if (!tabDirty(t)) continue
    await showTab(t)
    if (!(await confirmLeave(t))) return
  }
  api.forceClose()
})

api.on('update-status', (t: string) => {
  $('status-update').textContent = t ?? ''
})

// 底栏按钮：‹ 切换侧边栏，</> 源码模式
$('btn-sidebar').onclick = () => document.body.classList.toggle('no-sidebar')
$('btn-source').onclick = () => toggleSource()

// ---------- 启动 ----------
active = newTab({ content: WELCOME })
showTab(active).then(() => {
  const f = localStorage.getItem('folder')
  if (f) loadFolder(f).catch(() => localStorage.removeItem('folder'))
})
