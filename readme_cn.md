# Codex Switcher

[English](./README.md) | 中文

Codex Switcher 是一个本地厂商管理中心，为 Codex Desktop 提供统一入口。启动 Hub 后即可通过浏览器面板在 MiMo、FuseCode、OpenAI 兼容厂商和其他自定义厂商之间自由切换。

## 解决什么问题

Codex Desktop 使用 OpenAI Responses API 通信。许多第三方模型厂商只提供 Chat Completions 接口或厂商特定的兼容层，直接配置 Codex 往往行不通，或者需要反复修改 `~/.codex/config.toml`。

Codex Switcher 通过本地代理解决这个问题：

```text
Codex Desktop
  -> http://127.0.0.1:8789/v1
  -> Codex Provider Hub（本地代理）
      -> MiMo v2.5 Pro
      -> FuseCode
      -> 自定义 OpenAI Chat Completions 厂商
      -> 自定义 Responses API 厂商
```

启动 Hub 后，它会自动把 Codex 指向固定本地入口。之后切换厂商只需在 Hub 面板点击，下一次 Codex 请求立即使用新厂商，无需再碰配置文件。

## 功能特性

- 固定 Codex 入口：`http://127.0.0.1:8789/v1`
- 浏览器控制面板：`http://127.0.0.1:8790`
- 支持 macOS 和 Windows 一键启动
- 通过 `mimo2codex` 支持 MiMo v2.5 Pro
- 原生 Responses API 直通支持 FuseCode
- 支持自定义 OpenAI Chat Completions 厂商
- 支持自定义 Responses API 厂商
- 本地联网搜索增强，无需 MiMo 付费搜索插件
- 厂商配置和密钥本地存储在 `data/` 目录

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
2. 在后台启动 Hub 服务
3. 打开控制面板 `http://127.0.0.1:8790`

## 使用方式

使用上面的启动脚本运行 Hub。Hub 会自动维护 Codex 配置，让 Codex 始终通过以下固定入口访问模型：

```text
http://127.0.0.1:8789/v1
```

需要切换厂商时打开控制面板：

```text
http://127.0.0.1:8790
```

## 切换厂商

在控制面板 `http://127.0.0.1:8790` 中，点击厂商卡片即可切换。下一次 Codex 请求会自动使用新选择的厂商。

内置厂商：

| 厂商 | 类型 | 说明 |
|------|------|------|
| `mimo` | mimo2codex 适配 | MiMo v2.5 Pro，通过 `mimo2codex` 做协议转换 |
| `fusecode` | Responses API 直通 | FuseCode，原生支持 Responses API |

## 添加自定义厂商

在控制面板的 **添加自定义 OpenAI 兼容厂商** 表单中填写信息。

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
