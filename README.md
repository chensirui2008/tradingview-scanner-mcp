# TradingView Scanner MCP

运行于 Cloudflare Workers 的远程只读 MCP 服务：通过社区 TypeScript 封装访问无需登录的 TradingView 公共 Scanner，筛选美国交易所上市股票、查询快照及字段目录。不需要 TradingView 账号、Cookie 或券商凭据，不支持交易下单。

> [!WARNING]
> 公共 Scanner 不是承诺稳定性或实时性的正式行情服务。行情可能延迟、缺失或被限流；本项目不提供交易建议、信号批准或数据准确性保证。使用前请自行确认 TradingView 的服务条款、数据许可及适用限制；不得用来绕过访问控制或不当再分发行情。

## 本地运行与部署

需要 Node.js 22.23+、npm，以及具有 Workers 权限的 Cloudflare 账号。

```sh
npm ci
npm run dev
```

MCP 默认入口为 `http://127.0.0.1:8787/mcp`；`GET /health` 仅检查服务存活，不请求 TradingView。实际监听地址以 `cf dev` 输出为准。

```sh
npm run typecheck
npm test
npm run build
npm run deploy
```

项目通过 `cf` CLI、`cloudflare.config.ts` 和 Vite 构建部署，不使用 Wrangler 配置。部署前按 `cf` 提示完成 Cloudflare 登录/授权；部署输出给出实际 Workers URL，连接其 `/mcp` 路径。生产部署前建议设置下述密钥。

### 可选鉴权

未设置 Worker secret `MCP_API_KEY` 时，`/mcp` 为公开只读服务。设置后，每次 MCP HTTP 请求必须包含：

```http
Authorization: Bearer <MCP_API_KEY>
```

通过 Cloudflare 控制台的 Worker「Settings → Variables and Secrets」添加加密 secret `MCP_API_KEY`，不要提交密钥到 Git。`/health` 始终公开。服务拒绝不匹配的 Host、非同源的浏览器 Origin，并将请求体限制为 64 KiB；无 Origin 的原生 MCP 客户端可连接。服务没有 OAuth 登录流程。

默认仅允许本地地址及 `tradingview-scanner-mcp.<账号子域>.workers.dev` 主机。使用自定义域名或更改 Worker 名称时，在 Worker 环境变量 `MCP_ALLOWED_HOSTS` 中填写允许的完整主机（多个用英文逗号分隔，非默认端口需含端口），例如 `scanner.example.com`。这不会放宽浏览器同源校验。

客户端选择 Streamable HTTP / HTTP MCP，URL 填部署地址加 `/mcp`。本服务按请求创建 MCP server，不持久化会话，不需要 KV 或 Durable Objects。

已部署入口：`https://tradingview-scanner-mcp.siruichen461.workers.dev/mcp`。截至 2026-10-25，该部署为**公开只读**，尚未配置 `MCP_API_KEY`。

采用 `mcpServers` 与 `type: "http"` 配置格式的客户端（例如 Claude Code）可参考：

```json
{
  "mcpServers": {
    "tradingview-scanner": {
      "type": "http",
      "url": "https://tradingview-scanner-mcp.siruichen461.workers.dev/mcp"
    }
  }
}
```

这不是所有 MCP 客户端通用的配置文件格式；其他客户端请使用其自己的 HTTP/Streamable HTTP 配置。启用密钥后，还需按该客户端支持的方式添加上述 Authorization 请求头。

## MCP 工具

| 工具 | 用途 | 主要参数 |
| --- | --- | --- |
| `search_fields` | 查询安装的社区库实际字段目录 | `query?`（最多 100 字符）、`limit?`（1–100，默认 25）、`offset?`（0–10000） |
| `scan_stocks` | AND 条件筛选美国上市普通股/存托凭证 | `fields?`、`filters?`、`sort?`、`preset?`、`exchanges?`、`limit?`、`offset?` |
| `get_stock_snapshots` | 按交易所限定代码查询快照 | `symbols`（1–50 个）、`fields?` |
| `list_scan_presets` | 列出预设的可见条件和排序 | `{}` |

### 筛选示例

以下为 `scan_stocks` 的工具参数，不是直接 POST `/mcp` 的 JSON-RPC 消息：

```json
{
  "fields": ["name", "close", "volume", "exchange", "update_mode"],
  "exchanges": ["NASDAQ", "NYSE"],
  "filters": [
    {"field": "close", "operator": "gt", "value": 5},
    {"field": "volume", "operator": "gte", "value": 1000000}
  ],
  "sort": {"field": "volume", "direction": "desc"},
  "limit": 25,
  "offset": 0
}
```

字段使用 TradingView 原始 ID，先用 `search_fields` 查找；固定版本目录去重后包含 3521 个原始字段 ID。每次最多 40 个字段、20 个筛选条件。比较操作符为 `eq`、`ne`、`gt`、`gte`、`lt`、`lte`、`between`、`in`、`not_in`；`between` 要求恰好两个有限数值，按下界、上界升序排列。`in`、`not_in` 仅支持非空字符串数组，不支持数值或混合数组：上游对数值 `in_range` 的解释是区间而非离散集合，因此不能用它表达“价格等于 1 或 1000”。字段及操作数会在请求上游前验证。

`exchanges` 仅接受 `NASDAQ`、`NYSE`、`AMEX`，默认包含三者。基础股票池为 `type = stock` 且 `subtype` 为 `common` 或 `dr`，排除基金、优先股和权证等。这里的“美国股票”指美国交易所上市，不代表发行人注册地在美国。

预设为 `gainers`、`losers`、`most_active`、`unusual_volume`；其确切条件和排序由 `list_scan_presets` 返回，属于确定性筛选规则，不是买卖建议。

```json
{
  "symbols": ["NASDAQ:AAPL", "NYSE:IBM"],
  "fields": ["name", "close", "volume", "update_mode"]
}
```

快照代码必须带受支持的交易所前缀，不能只填 `AAPL`。返回中保留 `null`，不将缺失值补为零；未返回的代码列于 `meta.missingSymbols`。

## 返回值与数据语义

成功工具结果同时包含 JSON 文本和相同的 `structuredContent`，结构为 `data` 与 `meta`。扫描结果每行包含交易所限定 `symbol` 及请求字段。`meta` 包含来源、市场、抓取时间、分页、风险提示与请求追踪用 `requestId`；错误以 `isError: true` 及稳定的 `code`、`message`、`requestId` 返回。

- `fetchedAt` 是本服务完成抓取的时间，不是成交或报价时间；`dataFreshness: "unknown"` 不保证实时。
- 默认字段包含 `update_mode`。例如 `delayed_streaming_900` 表示上游声明的 900 秒延迟模式；不要把响应时间误当成实时行情证明。
- `close` 是上游价格字段，币种及单位取决于证券和对应字段；`volume` 为上游成交量，百分比类字段按字段目录/TradingView 定义使用，不能统一按小数比例解释。
- 扫描 `limit` 为 1–100（默认 25），`offset` 为 0–10000（默认 0）；分页元数据包含 `totalCount`、`returnedCount`、`hasMore` 和 `nextOffset`。这是偏移量分页，不是市场快照隔离：跨页数据可能随行情变化。
- 不保存账号状态，不缓存行情，不自动重试，不调度轮询。`/health` 正常不代表上游可用；网络错误、限流和上游异常应由调用方处理。

## 验证

确定性测试覆盖输入边界、字段目录、筛选条件组合、上游错误与 Worker 的鉴权、来源和请求体限制；不要求开市。真实网络 smoke 使用 MCP client 2.3.1，经 HTTP 完成握手、列工具、字段查询、预设目录、有限扫描、四种预设的条件与排序校验（每种 `limit: 2, offset: 1`）、AAPL/不存在代码快照、错误和重复无状态请求，不使用行情 mock。

```sh
# 先启动 npm run dev，或改为已部署的 HTTPS URL
MCP_URL=http://127.0.0.1:8787/mcp npm run smoke
# 启用鉴权时额外传入 MCP_API_KEY（不要把真实密钥粘贴到共享日志）
```

smoke 不依赖市场正在交易，但依赖外网及公共 Scanner 可用；失败不应直接解释为交易信号或市场状态。2026-10-25 验收已通过类型检查、21 项确定性测试，以及本地真实 workerd 和上述生产端点的完整 HTTP MCP smoke（4 个工具、5 条主扫描结果、四种预设非零偏移分页、条件与排序、AAPL/缺失代码及无状态调用）。生产 `/health` 返回 200，非同源 Origin 请求返回 403 `INVALID_ORIGIN`。部署版本为 `f3b1e686-49af-4c7c-becc-58e3a048d77f`，打包 gzip 约 440.66 KiB，启动时间 63 ms；这些是当次验收结果，不是持续可用性承诺。

## 上游封装与成熟度

使用社区项目 [jmargieh/tradingview-screener](https://github.com/jmargieh/tradingview-screener)，固定 npm `tradingview-screener@2.3.1`。`2.3.2` 的 npm 发布包缺少可运行的 `dist`，因此有意固定到包含构建产物的 `2.3.1`。复用该库的真实字段目录、筛选条件和查询构建器；网络传输使用 Workers 原生 `fetch`，因为库的 axios 为全局实例且 `get()` 不检查原始响应结构，不适合此处的请求隔离与响应校验要求。请求发送前仍由社区库构建 Scanner payload，并非用自写查询实现替代封装。社区封装及公共 Scanner 都可能变化，成熟度应保守评估；本项目不隶属 TradingView，也不应当视为官方支持的生产级行情 SLA。
