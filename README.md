# inkmd

一个类 Typora 的 Windows Markdown 编辑器，基于 Electron + Milkdown（所见即所得）。

## 功能

- 所见即所得编辑（Milkdown Crepe）：表格、代码高亮、数学公式、任务列表、图片
- 多标签页：同时打开多个文件，Ctrl+Tab 切换，Ctrl+W 关闭
- 侧边栏「文件 / 大纲」：文件夹目录树 + 标题大纲点击跳转
- 亮色 / 暗色主题（首次跟随系统）
- 粘贴或拖入图片自动保存到文档同级 assets/ 并插入相对路径
- 相对路径图片正常显示（自定义 localfile:// 协议）
- 导出 HTML / PDF
- `Ctrl+/` 切换源码模式
- 双击 .md 用 inkmd 打开、拖拽打开、外部修改自动重载
- 启动时检查新版本，有更新弹窗提示下载

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 新建标签 | Ctrl+N |
| 打开文件 / 文件夹 | Ctrl+O / Ctrl+Shift+O |
| 保存 / 另存为 | Ctrl+S / Ctrl+Shift+S |
| 关闭标签 / 切换标签 | Ctrl+W / Ctrl+Tab |
| 导出 PDF | Ctrl+P |
| 侧边栏 / 文件与大纲切换 | Ctrl+\ / Ctrl+Shift+L |
| 暗色主题 | Ctrl+Shift+D |
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

## 发布新版本

```bash
npm version patch          # 或 minor / major，会改 package.json 并打 tag
git push --follow-tags
```

推送 `v*` 标签后，GitHub Actions 会在 Windows 上打包，并把安装包 exe 上传到 Releases。
