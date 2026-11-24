# inkmd

一个类 Typora 的 Windows Markdown 编辑器，基于 Electron + Milkdown（所见即所得）。

## 功能

- 所见即所得编辑（Milkdown Crepe）：表格、代码高亮、数学公式、任务列表、图片
- `Ctrl+/` 切换源码模式
- 打开文件 / 文件夹，左侧目录树（只显示 .md）
- 拖拽 .md 进窗口打开
- 双击 .md 直接用 inkmd 打开（安装后自动关联）
- 文件被外部修改时自动重新加载
- 未保存提示、标题栏显示修改状态、字数统计

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 新建 | Ctrl+N |
| 打开文件 | Ctrl+O |
| 打开文件夹 | Ctrl+Shift+O |
| 保存 / 另存为 | Ctrl+S / Ctrl+Shift+S |
| 切换侧边栏 | Ctrl+\ |
| 源码模式 | Ctrl+/ |

## 开发

```bash
npm install
npm run dev     # 开发
npm run dist    # 打包 Windows 安装包，输出在 release/
```

## 结构

```
src/main/      主进程：窗口、菜单、文件读写、目录树、文件监听、单实例
src/preload/   安全地把 API 暴露给页面
src/renderer/  编辑器界面
```
