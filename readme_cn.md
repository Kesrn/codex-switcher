# Codex Switcher

[English](./README.md) | 中文

Codex Switcher 是一个本地厂商管理中心，为 Codex Desktop 提供统一代理入口。所有厂商都需要用户在面板中手动添加，然后再启动代理使用。

## 解决什么问题

Codex Desktop 使用 OpenAI Responses API 通信。许多第三方模型厂商只提供 Chat Completions 接口或厂商特定的兼容层，直接配置 Codex 往往行不通，或者需要反复修改 `~/.codex/config.toml`。

Codex Switcher 通过本地代理解决这个问题：

```text
Codex Desktop
  -> http://127.0.0.1:8789/v1
  -> Codex Provider Hub（本地代理）
      -> 手动添加的 OpenAI Chat Completions 厂商
      -> 手动添加的 Responses API 厂商
      -> 手动添加的 MiMo 兼容厂商
```

启动 Hub 后，先在面板里手动添加厂商和密钥，再点击 **启动代理**。启动后 Codex 走本地代理；点击 **关闭代理** 后恢复为原先的官方 OpenAI 配置。

## 功能特性

- 固定 Codex 入口：`http://127.0.0.1:8789/v1`
- 浏览器控制面板：`http://127.0.0.1:8790`
- 支持 macOS 和 Windows 一键启动
- 通过 `mimo2codex` 支持 MiMo 兼容厂商
- 原生 Responses API 直通
- 支持自定义 OpenAI Chat Completions 厂商
- 支持自定义 Responses API 厂商
- 本地联网搜索增强，无需 MiMo 付费搜索插件
- 厂商配置和密钥本地存储在 `data/` 目录
- 不再内置任何默认厂商配置，所有厂商都由用户手动添加

## 目录结构

```text
codex-switcher/
  README.md
  readme_cn.md
  codex-provider-hub/
    hub.js               # 核心逻辑：代理服务器、Web 面板、配置管理
    install-autostart.js  # 跨平台自启动注册
    open-mac.command      # macOS 一键启动
    open-windows.cmd      # Windows 一键启动
    package.json
  data/                   # 本地运行时数据，已加入 .gitignore
```

`data/` 目录包含厂商配置、API 密钥、运行日志和适配器状态，不要提交到 Git。

## 环境要求

- Node.js 18 或更高版本
- Codex Desktop
- 目标厂商的 API 密钥

## macOS 使用

双击运行：

```text
codex-provider-hub/open-mac.command
```

脚本会自动完成以下步骤：

1. 安装 npm 依赖（如尚未安装）
2. 注册 macOS LaunchAgent 实现开机自启
3. 打开控制面板 `http://127.0.0.1:8790`

## Windows 使用

双击运行：

```text
codex-provider-hub/open-windows.cmd
```

脚本会自动完成以下步骤：

1. 安装 npm 依赖（如尚未安装）
2. 注册 Windows 启动项并在后台启动 Hub 服务
3. 打开控制面板 `http://127.0.0.1:8790`

## 桌面应用

Hub 也可以作为 Electron 桌面应用运行，不需要再依赖外部浏览器：

```bash
cd codex-provider-hub
npm install
npm run app
```

桌面应用会启动或复用本地 Hub，并在应用窗口中打开同一个控制台。

## 打包安装包

在 `codex-provider-hub` 目录下构建桌面安装包：

```bash
cd codex-provider-hub
npm install
npm run dist:mac   # 生成 macOS .dmg
npm run dist:win   # 生成 Windows .exe 安装器，建议在 Windows 上运行
npm run dist       # 构建当前环境支持的全部目标
```

产物会输出到 `codex-provider-hub/dist/`：

- macOS：`Codex Switcher-<version>-<arch>.dmg`
- Windows：`Codex Switcher-Setup-<version>-x64.exe`

正式发布建议分别在 macOS 和 Windows 环境打包。macOS 跨平台构建 Windows 安装器通常需要 Wine 以及 Electron Builder 的 Windows 辅助依赖。

## 使用方式

使用上面的启动脚本运行 Hub。先在控制面板中手动添加厂商，再点击 **启动代理**，Codex 会通过以下固定入口访问模型：

```text
http://127.0.0.1:8789/v1
```

需要添加、测试、切换厂商或启动/关闭代理时打开控制面板：

```text
http://127.0.0.1:8790
```

## 切换厂商

控制面板不会预置任何厂商。先手动添加厂商、Base URL、模型和 API Key，再点击厂商卡片切换。代理启动后，下一次 Codex 请求会使用当前选择的厂商。

## 添加厂商

在控制面板的 **添加自定义厂商** 表单中填写信息。

**OpenAI Chat Completions 兼容厂商：**

```text
类型：OpenAI Chat Completions
Base URL：https://example.com/v1
模型：your-model-name
API Key：your-key
```

**原生支持 Responses API 的厂商：**

```text
类型：Responses API
Base URL：https://example.com
模型：your-model-name
API Key：your-key
```

密钥仅保存在本地 `data/keys.json` 文件中。

## 本地联网搜索

MiMo 官方的搜索插件需要单独付费。Codex Switcher 不会将 Codex 的 `web_search` 工具直接发送给 MiMo，而是在检测到用户问题可能需要实时信息时，由 Hub 本地抓取搜索结果并注入到请求上下文中。

这是一个轻量级的辅助功能，效果取决于公开搜索结果的质量，与厂商官方付费插件不完全等同。

## 手动运行

```bash
cd codex-provider-hub
npm install
npm start
```

开发时运行桌面应用：

```bash
npm run app
```

常用地址：

| 用途 | 地址 |
|------|------|
| Hub 控制面板 | `http://127.0.0.1:8790` |
| Codex API 入口 | `http://127.0.0.1:8789/v1` |
| 模型列表 | `http://127.0.0.1:8789/v1/models` |

## 安全说明

以下内容已通过 `.gitignore` 排除，不会被提交：

- `data/` 目录（配置、密钥、日志）
- `node_modules/`

**请勿提交 `data/keys.json`。**
