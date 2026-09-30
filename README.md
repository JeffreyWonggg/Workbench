# 工作台 Workbench

完全离线运行的个人工作台。待办、周报、笔记、资料库、项目、代码（git）、更新软件版本、局域网传文件都在同一套界面里，**数据保存在你自己的文件夹中，不上传任何服务器**。

---

## 一分钟上手

1. 双击 **`打开工作台.bat`** —— 启动本地服务并打开 `http://127.0.0.1:47321/`
2. 首次使用会要求**选择一个数据文件夹**（待办/周报/笔记等会写进去，建议专门建一个空文件夹，比如 `D:\WorkbenchData`）
3. 需要局域网传文件时，先双击一次 **`启用局域网访问.bat`**（见下文「局域网」）

> 建议始终用 `打开工作台.bat` 进入，即 `http://127.0.0.1` 这个地址。用 `file://` 直接双击 HTML 打开会缺少本地服务能力。

---

## 功能一览

| 页面 | 做什么 |
|---|---|
| **工作台**（首页） | 今天到期的待办、本周概览、可配置的工具启动菜单 |
| **项目** | 按项目聚合待办/笔记/周报工时/资料/代码/软件号；总览页显示每个项目的概况 |
| **待办** | 待办与状态、截止日、项目归属；逾期会在侧栏角标提醒 |
| **周报** | 按周记录各项目的工时与工作项；可从「已完成待办」一键填入；支持 AI 润色/扩写并导出 Markdown |
| **笔记** | 分级标题的块式笔记，支持表格、块内编辑、上下移动、项目归属 |
| **资料库** | 账号密码、路径、主机等条目；**主密码加密存储**（PBKDF2-SHA256 + AES-GCM），可记住密码、导出明文、从备份回滚 |
| **代码** | 本机 git 仓库管理：扫描发现、状态、改动暂存/提交、历史与差异、分支、标签、获取/拉取/推送（含强制推送）、反向提交与硬回滚、发布流水、软件号（明文） |
| **菜谱** | 记录菜名、分类、食材清单、做法步骤；支持关键词搜索与分类筛选、展开收起全文；删除进回收站可恢复；`Ctrl+K` 可搜 |
| **局域网传文件** | 手机/其它电脑在同一 WiFi 下打开局域网地址即可上传下载（支持整个文件夹、打包下载） |
| **产品目录查询** | 读取 sqlite 索引库查询产品信息；另有一份只存在本机的自建目录 |
| **更新软件版本** | 编辑 `UpdateVersion.ini`：改版本、复制条目、发布前预览、一键发布；与「代码」页的标签/发布流水联动 |
| **回收站** | 软删除的待办/笔记/菜谱在这里恢复或彻底删除 |
| **关于** | 本页所有文字（名称、简介、作者、版本、版权）都读根目录的 **`about.json`**，改完刷新即可 |

**通用**：深色/浅色主题、侧栏可拖动排序、`Ctrl+K` 命令面板（可搜待办/笔记/资料/软件号）、全局撤销（删除后 Toast 带「撤销」）。

---

## 技术框架

**设计取向：零依赖、零构建、离线优先。** 没有 npm、没有 bundler、没有 CDN 请求，克隆下来就能跑。

| 层 | 用的东西 |
|---|---|
| 前端 | 原生 HTML + CSS + ES2020 JavaScript（无框架），模块以 IIFE 挂到 `window`（`Workbench` / `Nav` / `GitApi` / `Storage` / `VaultCrypto` 等） |
| 样式 | 单文件 `css/app.css`，CSS 变量 + `[data-theme]` 双主题；字体本地自托管（`fonts/*.woff2`） |
| 数据读写 | **File System Access API**：用户自己选数据文件夹，句柄存 IndexedDB，数据以纯 JSON 文件落地（`meta.json`、`todos.json`、`notes.json`、`reports.json`、`notes/`、`software.json`…） |
| 加密 | WebCrypto：PBKDF2-SHA256 派生密钥 + AES-GCM 加密资料库（`vault.json`），每次写入自动留 `vault.backup.json` |
| 本地服务 | **C# / .NET Framework**（`scripts/workbench-host.cs`，用 `csc` 编译成单个 `workbench-host.exe`），`HttpListener` 提供 HTTP 接口，WinForms 弹原生文件/文件夹选择框 |
| 数据库 | `sql.js`（SQLite 编译成 WebAssembly）在浏览器里只读查询 `.db` |
| 二维码 | 自带 `js/vendor/qrcode.js` |
| AI | 兼容 OpenAI 协议的 `chat/completions` 接口（DeepSeek / 火山方舟），密钥放本机 `js/openrouter.local.js` |

### 本地服务接口

| 接口 | 用途 |
|---|---|
| `GET /` 及静态文件 | 提供页面；有屏蔽名单，禁止路径穿越 |
| `POST /open` | 用系统默认程序打开本机文件/文件夹 |
| `POST /run-tool` | 按 `meta.json` 的 `tools` 配置启动本机程序 |
| `POST /publish`、`GET/POST /update-version-ini` | 更新软件版本的预览与发布 |
| `GET/POST /config` | 读写本机配置（如 `UpdateVersion.ini` 路径） |
| `POST /pick-file` | 弹 Windows 原生对话框（`mode=file` 选文件 / `mode=dir` 选文件夹） |
| `GET /fs/list` | 列目录（页面内目录浏览器用） |
| `/lan/*` | 局域网传文件的列表、上传、下载、删除、打包 zip |
| `/git/*` | `scan` / `status` / `log` / `diff` / `branches` / `tags` / `exec` |

**安全约束**（重要）：所有写操作都校验来源（只认 `http://127.0.0.1:47321`），局域网来源一律 403；`/git/*` 更进一步——**客户端只说“做什么动作”，命令行由服务端白名单拼装**，从根上避免参数注入；仓库必须位于已登记的代码根目录下，路径不允许含 `..`。

---

## 目录结构

```
Workbench/
├─ 打开工作台.bat          启动本地服务并打开页面
├─ 启用局域网访问.bat      检查/配置局域网访问所需的 URL 保留与防火墙规则
├─ index.html 等各页面     每个页面一个 HTML，直接引入 js/*.js
├─ about.json             「关于」页的全部文案（可自行编辑）
├─ css/app.css            全部样式（含深浅两套主题）
├─ fonts/                 本地字体
├─ js/
│  ├─ nav.js              侧栏、导航、命令面板、Toast、公共目录选择器
│  ├─ model.js            数据读写核心（各 JSON 的读写与容错）
│  ├─ storage.js          File System Access API 封装
│  ├─ vault-crypto.js     资料库加密
│  ├─ home/todo/weekly/notes/resources/project/sn/version/lan/trash/about.js
│  ├─ recipes.js          「菜谱」页（列表、搜索与分类筛选、新增/编辑、软删除）
│  ├─ code.js + gitapi.js 「代码」页与其 git 接口封装
│  └─ vendor/qrcode.js、sql-wasm.js
├─ scripts/
│  ├─ workbench-host.cs   本地服务源码
│  ├─ build-host.ps1      编译 + 重启脚本（失败自动保留原 exe）
│  └─ workbench-host.exe  编译产物（已 gitignore）
├─ notes/                 数据文件夹（默认位置之一，已 gitignore）
└─ lan/                   局域网收到的文件（已 gitignore）
```

---

## 局域网传文件

1. 双击一次 **`启用局域网访问.bat`**。它会检查两件事并以普通用户身份完成能做的部分：
   - `http://+:47321/` 的 **URL 保留**（缺了服务就只能监听 127.0.0.1，局域网连不上）
   - **防火墙**是否放行 TCP 47321（仅当防火墙处于开启状态才需要）
   - 缺配置时会打印出需要**管理员权限执行一次**的命令（可直接交给 IT），并照常把服务重启好 —— 本机使用不受影响
2. 打开「局域网传文件」页，复制显示的地址（或让对方扫二维码），对方用浏览器打开即可上传/下载
3. 支持直接拖入整个文件夹；隐藏文件/文件夹（`.git` 等）会被跳过，这是设计如此

> 公司电脑若没有管理员权限：URL 保留和防火墙规则都无法自行添加，需要 IT 授权一次。局域网地址走的是明文 HTTP，因此**数据页（待办/资料库等）在其它设备上不可用**，页面会明确提示，只有不需要数据文件夹的「局域网传文件」等页面可用。

---

## AI 配置（可选）

周报的「AI 润色」需要一个模型密钥。在 `js/openrouter.local.js` 里写（该文件已 gitignore，不会进版本库）：

```js
window.DEEPSEEK_API_KEY = "sk-...";
window.ARK_API_KEY = "你的火山方舟 Key";
```

模型清单在 `js/weekly.js` 顶部的 `MODELS` 数组里，新增模型照着加一行即可。润色力度对应不同温度：保守润色 0.3 / 适度扩写 0.5 / 充分扩写 0.7。

---

## 重新编译本地服务

改动 `scripts/workbench-host.cs` 后：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-host.ps1
```

脚本会：备份当前 exe → 用 `csc` 编译 → 停掉旧进程 → 替换 → 重启。**编译失败不会动正在用的 exe**；需要回滚时执行 `build-host.ps1 -Rollback`。

---

## 数据与隐私

- 待办、周报、笔记、资料库全部写在你选择的数据文件夹里，是**可读的纯 JSON 文件**，随时可以自己备份、查看、手工修改
- 资料库用主密码加密（AES-GCM），密文落盘为 `vault.json`，每次保存前会留一份 `vault.backup.json`
- 除 AI 润色（把周报文本发给你自己配置的模型接口）外，**没有任何数据离开本机**
- 本仓库已排除：`notes/`（数据）、`vault*.json`、`lan/`、`clipboard-history.json`、`catalog.db`、`otdr_index.db`、`js/openrouter.local.js`（密钥）、`workbench.config.json`（本机路径）

---

## 常见问题

**页面提示“请用 Edge 或 Chrome 打开” / “数据功能仅限本机使用”**
数据文件夹读写依赖 File System Access API，它要求安全上下文（HTTPS 或 `127.0.0.1`）。用局域网 IP 访问时浏览器不会提供该 API，换浏览器也没用 —— 数据页请在本机打开。

**周报 AI 提示没有密钥**
检查 `js/openrouter.local.js` 是否存在且变量名正确（`window.DEEPSEEK_API_KEY` / `window.ARK_API_KEY`）。

**代码页提示“被本地服务拒绝（403）”**
必须从 `http://127.0.0.1:47321` 打开页面；局域网地址访问时 git 接口会拒绝。

**代码页扫描后仓库被删了，列表里还留着**
点一次「扫描仓库」即可：它会确认目录是否真的不存在，真没了就移出列表（并记住项目绑定，重新克隆后自动恢复）。
