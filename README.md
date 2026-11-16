# 数字出版目录的借阅授权与获取路径采集

这是面向资料接收人员的 Node.js 服务。当前提供人工收件、合作目录自动采集、原始字节保管、业务身份版本记录和收件查询；本地来源独立提供合作方交互环境。自动采集只领取本馆 `/policy` 允许用途的正文，逐条给出选择依据供馆员复核；样章永不登记为正文，人工导入也不会被宣称为自动采集。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、HTTP 入口、自动采集及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`；`SOURCE_URL` 指定自动采集的合作来源，默认 `http://127.0.0.1:4200`。`npm run demo` 使用临时目录和系统分配端口演示人工收件与自动采集（含席位等待与续借实例），结束即清理，通常只需数秒。

## 容器

`docker build -t licensed-publications:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 licensed-publications:local` 启动。环境准备后，`docker run --rm --network none licensed-publications:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查现有功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象。`POST /api/collect` 对配置的来源执行一轮自动采集并返回复核报告；上一轮未完成返回 409，来源不可达返回 502。`GET /api/review` 返回最近一次复核报告，尚未采集返回 404。`GET /api/records` 查询全部收件版本，`GET /health` 检查进程。人工记录身份字段为 publication, license。同一身份与相同原文重复提交复用版本，内容变化保留旧版本；不同来源不能混淆。归档目录有按摘要保存的 blobs 和按业务身份保存的 receipts。

## 自动采集的登记模型

- 目录条目、正文、授权实例一一对应：每条目录以 `{publication, license: "catalog-entry"}` 登记书目；正文以 `{publication, license: 授权实例}` 登记，授权实例取自来源的 `x-license-id`（如 `open-1`、`loan-1`），正文记录通过 `catalogEntry` 指回目录条目。
- 获取关系按 `acquisition/open-access`、`acquisition/borrow`、`preview` 区分；`preview` 样章永不登记为正文。同一书目存在多种格式或路径时选定一条，其余在复核报告的 `alternatives` 中列出。
- 用途以来源 `/policy` 为准：`archive-open` 登记为永久馆藏，`temporary-reading` 登记为临时阅读；未声明或不在允许范围的用途不自动同意。
- 借阅席位不可用（409）时以 `{publication, license: "loan-waiting"}` 登记等待记录，不以样章或其他路径顶替；席位恢复后再次采集即可领取。
- 续借、到期、新授权实例各自独立登记，互不并入同一份馆藏；旧实例到期不影响目录条目存续，到期不等于下架。
- 授权凭据仅用于对应借阅的内容地址，不跟随重定向，不传给预览或其他端点。外部支付、破解保护、自动同意额外条款均不在采集范围。

`src/` 为收件、采集与传输，`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`，该文档不规定新增接入的架构。
