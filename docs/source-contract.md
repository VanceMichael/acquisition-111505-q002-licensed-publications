# 合作来源约定

## 资料边界

/catalog 使用 OPDS 风格 JSON 的 metadata、links、publications。关系 acquisition/open-access、acquisition/borrow、preview 各有独立含义。借阅 /loans/{publication} 返回 loanId、expires、state 和内容 href；续借生成新 loanId，旧借阅可 expired。/policy 只允许 archive-open 和 temporary-reading 两种用途。授权凭据只随对应内容 href 使用，不能传给预览站。目录页有 next 链接。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/catalog`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。
