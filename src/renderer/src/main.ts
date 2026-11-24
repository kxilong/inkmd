import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import './style.css'

type TreeNode = { name: string; path: string; children?: TreeNode[] }

const api = window.api
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const editorEl = $('editor')
const sourceEl = $<HTMLTextAreaElement>('source')
const treeEl = $('tree')

const state = {
  path: null as string | null,
  saved: '', // 上次保存时的内容
  content: '',
  folder: null as string | null,
  sourceMode: false
}

let crepe: Crepe | null = null

// ---------- 编辑器 ----------
async function mountEditor(markdown: string) {
  await crepe?.destroy()
  editorEl.innerHTML = ''
  crepe = new Crepe({ root: editorEl, defaultValue: markdown })
  crepe.on((l) => {
    l.markdownUpdated((_ctx, md) => {
      state.content = md
      refreshTitle()
    })
  })
  await crepe.create()
  state.content = crepe.getMarkdown()
}

function currentMarkdown() {
  return state.sourceMode ? sourceEl.value : crepe?.getMarkdown() ?? state.content
}

const isDirty = () => currentMarkdown() !== state.saved

function basename(p: string) {
  return p.split(/[\\/]/).pop() ?? p
}
function dirname(p: string) {
  return p.replace(/[\\/][^\\/]*$/, '')
}

function refreshTitle() {
  const name = state.path ? basename(state.path) : '未命名'
  api.setTitle(`${isDirty() ? '● ' : ''}${name} - inkmd`)
  $('status-path').textContent = state.path ?? '未命名'
  const text = currentMarkdown()
  $('status-info').textContent = `${text.replace(/\s/g, '').length} 字`
}

// 让相对路径的图片能显示：把 <base> 指向当前文件所在目录
function setBase(p: string | null) {
  let base = document.querySelector('base')
  if (!p) return base?.remove()
  if (!base) {
    base = document.createElement('base')
    document.head.prepend(base)
  }
  base.href = 'file:///' + dirname(p).replace(/\\/g, '/') + '/'
}

// ---------- 文件操作 ----------
async function confirmLeave(): Promise<boolean> {
  if (!isDirty()) return true
  const r = await api.confirmDiscard()
  if (r === 'cancel') return false
  if (r === 'save') return await save()
  return true
}

async function openPath(p: string) {
  if (p === state.path) return
  if (!(await confirmLeave())) return
  const text = await api.readFile(p)
  state.path = p
  state.saved = text
  setBase(p)
  if (state.sourceMode) sourceEl.value = text
  await mountEditor(text)
  state.saved = currentMarkdown() // 以编辑器规范化后的内容为基准，避免一打开就显示“已修改”
  await api.watch(p)
  highlightActive()
  refreshTitle()
}

async function newFile() {
  if (!(await confirmLeave())) return
  state.path = null
  state.saved = ''
  setBase(null)
  sourceEl.value = ''
  await mountEditor('')
  await api.watch(null)
  highlightActive()
  refreshTitle()
}

async function save(): Promise<boolean> {
  if (!state.path) return saveAs()
  const md = currentMarkdown()
  await api.writeFile(state.path, md)
  state.saved = md
  refreshTitle()
  return true
}

async function saveAs(): Promise<boolean> {
  const p = await api.saveAsDialog(state.path ?? undefined)
  if (!p) return false
  state.path = p
  setBase(p)
  await save()
  await api.watch(p)
  if (state.folder) loadFolder(state.folder)
  return true
}

// ---------- 源码模式 ----------
async function toggleSource() {
  if (state.sourceMode) {
    const md = sourceEl.value
    state.sourceMode = false
    sourceEl.hidden = true
    editorEl.hidden = false
    await mountEditor(md)
  } else {
    sourceEl.value = crepe?.getMarkdown() ?? ''
    state.sourceMode = true
    editorEl.hidden = true
    sourceEl.hidden = false
    sourceEl.focus()
  }
  refreshTitle()
}
sourceEl.addEventListener('input', refreshTitle)
sourceEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault()
    sourceEl.setRangeText('  ', sourceEl.selectionStart, sourceEl.selectionEnd, 'end')
  }
})

// ---------- 侧边栏目录树 ----------
async function loadFolder(dir: string) {
  state.folder = dir
  $('folder-name').textContent = basename(dir)
  const tree: TreeNode[] = await api.readTree(dir)
  treeEl.innerHTML = ''
  treeEl.appendChild(renderTree(tree))
  highlightActive()
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
    el.classList.toggle('active', (el as HTMLElement).dataset.path === state.path)
  })
}

async function openFolder() {
  const dir = await api.openFolderDialog()
  if (dir) loadFolder(dir)
}
$('btn-open-folder').onclick = openFolder

// ---------- 拖拽打开 ----------
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => {
  e.preventDefault()
  const f = e.dataTransfer?.files[0] as (File & { path?: string }) | undefined
  if (f?.path && /\.(md|markdown)$/i.test(f.path)) openPath(f.path)
})

// ---------- 主进程事件 ----------
api.on('menu', async (cmd: string) => {
  switch (cmd) {
    case 'new': return newFile()
    case 'open-file': {
      const p = await api.openFileDialog()
      if (p) openPath(p)
      return
    }
    case 'open-folder': return openFolder()
    case 'save': return save()
    case 'save-as': return saveAs()
    case 'toggle-sidebar': return document.body.classList.toggle('no-sidebar')
    case 'toggle-source': return toggleSource()
  }
})

api.on('open-path', (p: string) => openPath(p))

api.on('file-changed', async (p: string) => {
  if (p !== state.path) return
  const text = await api.readFile(p)
  if (text === state.saved) return
  if (isDirty() && !confirm('文件已在外部被修改，要重新加载并丢弃你的修改吗？')) return
  state.saved = text
  if (state.sourceMode) sourceEl.value = text
  else await mountEditor(text)
  state.saved = currentMarkdown()
  refreshTitle()
})

api.on('request-close', async () => {
  if (await confirmLeave()) api.forceClose()
})

// ---------- 启动 ----------
mountEditor('# 欢迎使用 inkmd\n\n直接开始写，或者用 `Ctrl+O` 打开文件、`Ctrl+Shift+O` 打开文件夹。\n').then(() => {
  state.saved = currentMarkdown()
  refreshTitle()
})
