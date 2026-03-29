# Hanzi Browse 中文安装指南

这份文档不是逐句翻译 README，而是按国内开发者常见的使用场景来写：

- 只想先把扩展跑起来，看看值不值得折腾
- 机器在中国区网络环境，`npm install`、Chrome Web Store、YouTube demo 访问不稳定
- 用的是 Windows PowerShell，没有 `make`
- 想本地起开发环境，但不想在第一步就被 Docker、Google OAuth、Vertex AI 这些东西劝退

如果你想先看项目全貌，再回来照着装，可以先读：[中文版 README](./README.md)

## 先说结论

### 如果你只是想体验浏览器扩展

你其实不需要先把整套后端都跑起来。最短路径是：

1. 安装根目录依赖
2. 构建扩展
3. 在 `chrome://extensions` 手动加载 `dist/`

这样就能先看到扩展本体，Chrome Web Store 打不开也不影响。

### 如果你想跑完整本地开发环境

README 里的标准流程是：

```bash
make fresh
```

但这条命令默认站在 macOS / Linux 的角度写的。在 Windows 上，你通常要手动拆成几步来跑。后面我会给你一份 PowerShell 版本。

## 环境准备

先确认这些东西都在：

- Node.js 18 或更高
- npm
- Docker Desktop
- 一个 Chromium 内核浏览器：Chrome、Edge、Brave 都行

可选但很省事：

- Git Bash 或 WSL，如果你想尽量原样照着 `make` 走

## 中国区网络环境下最容易卡住的地方

### 1. npm 安装慢

默认先试官方源。如果你本机拉 npm 包一直超时，再切镜像。

临时用镜像装依赖：

```bash
npm install --registry=https://registry.npmmirror.com
```

如果你想全局切过去：

```bash
npm config set registry https://registry.npmmirror.com
```

装完想切回官方源：

```bash
npm config set registry https://registry.npmjs.org
```

经验建议：

- 网络本来就稳的话，别急着改全局 registry
- 如果只是偶发超时，优先用单次命令参数，不要一上来全局改配置

### 2. Chrome Web Store 打不开

这个仓库本身就支持手动侧载扩展，所以别把 Chrome Web Store 当成硬前置。

开发阶段推荐直接这样装：

1. 跑出根目录的 `dist/`
2. 打开 `chrome://extensions`
3. 打开右上角 Developer Mode
4. 点 “Load unpacked”
5. 选择仓库根目录的 `dist/`

只要 `dist/` 构建成功，扩展就能装。

### 3. 某些上游服务访问不稳定

下面这些能力依赖国外服务，国内网络下不一定顺：

- Chrome Web Store
- YouTube demo
- Google OAuth
- Stripe
- Vertex AI
- 你自己选的 AI provider（比如 OpenAI、Anthropic 等）

这不代表 Hanzi Browse 不能用，而是说明你要分清自己现在在测哪一层：

- **只测扩展 UI / 本地构建**：可以先不碰这些服务
- **只测手动加载扩展**：不需要 Chrome Web Store
- **要测 Managed 模式、OAuth、支付、Vertex AI**：就需要准备能稳定访问对应上游服务的网络环境

## 路线 A：只把扩展跑起来

这条路线最适合第一次上手。

### 1. 拉代码

```bash
git clone https://github.com/hanzili/hanzi-browse
cd hanzi-browse
```

### 2. 安装根目录依赖

```bash
npm install
```

如果慢，就带上镜像：

```bash
npm install --registry=https://registry.npmmirror.com
```

### 3. 构建扩展

```bash
npm run build
```

### 4. 手动加载扩展

打开 `chrome://extensions`：

1. 打开 Developer Mode
2. 选择 “Load unpacked”
3. 选择仓库根目录下的 `dist/`

到这里，你已经能在浏览器里看到 Hanzi Browse 扩展了。

## 路线 B：跑完整本地开发环境

### macOS / Linux

如果你就在 macOS 或 Linux，而且本机有 `make`，那就直接按原 README 走：

```bash
git clone https://github.com/hanzili/hanzi-browse
cd hanzi-browse
make fresh
```

后续日常开发用：

```bash
make dev
```

### Windows PowerShell

Windows 上最常见的问题不是 Node，也不是 Docker，而是 README 默认你有 `make` 和类 Unix shell。PowerShell 用户可以直接按下面这套等价步骤来。

### 1. 拉代码并进入目录

```powershell
git clone https://github.com/hanzili/hanzi-browse
cd hanzi-browse
```

### 2. 复制环境变量模板

```powershell
Copy-Item .env.example .env
```

默认配置已经够你把本地服务跑起来。只有当你要测 Google 登录、Stripe、Vertex AI 时，才需要再补 `.env`。

### 3. 安装三层依赖

```powershell
npm install
cd server
npm install
cd dashboard
npm install
cd ..\..
```

### 4. 构建扩展

```powershell
npm run build
```

### 5. 构建 server 和 dashboard

```powershell
cd server
npm run build
cd ..
```

如果这一步遇到 TypeScript 报错，建议先区分是环境问题还是源码问题：

- 先确认三层依赖都已经装完
- 再看最新的 `main` 和已有 issue，确认是不是当前版本本身就存在未收敛的构建问题
- 不要一上来就把问题归因到 npm 镜像或中国区网络环境

### 6. 启动 Docker Desktop

这一步别省。`docker --version` 有输出，不代表 Docker Engine 已经真的启动。

确认方法：

```powershell
docker info
```

如果这条命令报错，先把 Docker Desktop 打开并等它完全启动。

### 7. 起本地 Postgres

```powershell
docker compose up -d postgres
```

本地数据库会映射到 `localhost:5433`，避免和你机器上自己的 5432 冲突。

### 8. 跑数据库 schema

```powershell
docker compose exec -T postgres psql -U hanzi -d hanzi -f /docker-entrypoint-initdb.d/schema.sql
```

### 9. 补上 Windows 下的目录链接

README 里的 `make setup` 会创建两个链接目录，`server` 里启动 managed API 时会用到它们。

在 PowerShell 里可以这样建目录联接：

```powershell
New-Item -ItemType Junction -Path server\landing -Target .\landing
New-Item -ItemType Junction -Path server\sdk -Target .\sdk
```

如果目录已经存在，就跳过这步。

### 10. 启动 managed API

```powershell
cd server
node dist/managed/deploy.js
```

正常情况下可以访问：

- <http://localhost:3456/dashboard>

## Chrome 扩展侧载说明

如果 Chrome Web Store 访问不了，或者你就是在本地开发，推荐一直用侧载，不必纠结商店安装。

步骤再总结一遍：

1. 构建出 `dist/`
2. 打开 `chrome://extensions`
3. 开启 Developer Mode
4. Load unpacked
5. 选 `dist/`

每次你重新构建扩展之后，去扩展页点一下刷新就行。

## 常见问题

### `make` 找不到

这在 Windows 上很正常，不是你装错了。

解决思路有两个：

- 用 Git Bash / WSL，尽量按 README 原样跑
- 用这份文档里的 PowerShell 分步命令

### `docker --version` 正常，但 `docker info` 报错

说明 Docker CLI 装了，但 Docker Desktop 还没真正启动。

### `npm run build` 能过，但 `cd server && npm run build` 失败

先确认依赖安装完整；如果依赖没问题，再去看最新主分支和已有 issue，判断是不是当前版本本身的源码问题。

### Chrome Web Store 打不开

直接侧载 `dist/`，完全不影响本地开发。

### 要不要准备“特殊网络环境”

如果你只是想本地构建、手动加载扩展、看 UI，不一定需要。

如果你要测试这些功能，就要确认你能稳定访问对应服务：

- Managed 模式
- Google OAuth
- Stripe
- Vertex AI
- 你选的 LLM 提供商

## 更像给朋友的建议

第一次上手，建议别一口气把所有功能都跑通。更稳的顺序是：

1. 先 `npm install`
2. 先把 `npm run build` 跑通
3. 先把扩展侧载到浏览器里
4. 确认你真的需要 dashboard / managed API，再去折腾 Docker、数据库和 OAuth

这样心态会好很多，也更容易判断问题到底出在仓库、环境，还是上游服务。
