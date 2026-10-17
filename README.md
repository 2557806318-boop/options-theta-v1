# Options Theta — ETH 到期日期权纸盘研究系统

一个基于 Node.js、MySQL 和 Binance 官方行情的事件驱动期权研究项目。采用有保护腿的等宽铁鹰组合，研究时间价值衰减与波动率风险溢价；不是单纯预测涨跌，也不保证盈利。

**仅模拟交易。** 交易所适配器只允许白名单 GET 查询；没有真实下单、撤单、转账或实盘开关。100 USDT 是独立纸盘初始资金，不是真实账户余额。模拟成交延迟不代表真实交易所成交延迟。

## 系统设计

```text
官方合约 / 行情 / 深度 / 费率
          ↓
已完成 K 线 → RV / IV / 独立 Greeks → 四腿候选与风险预算
          ↓
保护腿优先 → 逐腿模拟 FOK → 失败回收 / 持仓管理
          ↓
MySQL 事务账本 + 幂等事件 + CAS 版本控制
          ↓
只读控制台 / Telegram / 持久化延迟统计
```

- 每秒扫描 ETH 同日到期机会，每 100ms 更新持仓风险；WebSocket 更新深度，REST 用于初始化和校验。
- 十进制定点处理金额、数量、费用及支付函数；统计和 Greeks 使用数值浮点，独立验证单位与符号。
- MySQL 事务原子更新现金、仓位及事件；唯一事件 ID 防重复，CAS 防过期写入，数据库锁限制单引擎运行。
- `BUILDING / OPEN / UNWINDING / CLOSED / SETTLEMENT_PENDING / UNKNOWN` 状态机；超时和缺数据不伪造成交。
- 行情异步压缩归档，普通行情保留 30 天，压缩载荷配额 4GiB；到限暂停普通归档并告警，不删除成交审计。
- 分开统计计算、REST、数据库和模拟等待的 p50/p95/p99、样本量和区间。

## 冻结试验规则

| 项目 | 规则 |
|---|---|
| 资产 | ETH 交易研究，BTC 仅观察 |
| 入场 | 距到期 2–8 小时，同到期日、等数量、等宽四腿 |
| 方向敞口 | 两条卖腿绝对 Delta 0.10–0.25；单位组合绝对净 Delta ≤0.05；净 Theta >0 |
| 波动率 | 已完成 24 小时 1 分钟行情；两条卖腿可成交 IV ≥ max(1h,6h,24h RV) ×1.20 |
| 异常波动 | 15m RV >6h RV ×1.5 时暂停新仓 |
| 风险 | 结构损失加费用、滑点和建仓失败预留 ≤权益 5% |
| 保证金 | 空头逐腿独立计算；初始保证金、保护腿成本及开仓费用合计 ≤权益 30% |
| 并发 | 最多一组，每到期日最多两次尝试；最小合约数量超预算则跳过 |
| 止盈 | 可实现费后利润达到入场净权利金 50% |
| 退出 | 平仓净成本达到毛权利金 2 倍，或空头绝对 Delta ≥0.40，或维持保证金/调整后权益 ≥50% |
| 强制管理 | 到期前 1 小时开始平仓；无可成交盘口时保留真实状态，不假设成交 |

结构到期最大亏损为 `价差宽度 × 合约单位 × 数量 − 毛权利金`，但这**不是**普通账户保证金需求，也不消除提前强平和执行失败风险。先确认保护腿，再模拟卖腿；失败时先平空头，再处理保护腿。

手续费使用签名查询得到的账户费率及逐腿封顶规则。行权费采用源码中的基础规则，部署者需持续核验交易所变更。收到权利金不是已实现利润，未平仓权益按可平仓价格计量。归因估计不计入实际纸盘收益。

## 本地开发

需要 Node.js ≥24；运行服务另需本机 MySQL、官方查询权限以及可选的 Telegram 凭据。

```sh
npm ci --ignore-scripts
npm test
npm run check
cp .env.example .env
# 配置独立的 options_theta 数据库和仅限该库的用户，再填写本机 .env。
npm start
```

`.env.example` 默认暂停新仓，关闭 Telegram。启用 Telegram 前设置授权 chat ID，并确保同一 token 只有一个更新接收进程。不得将真实密钥或数据库提交到 Git。

MySQL 用户需要对独立 `options_theta` 库创建表及读写的权限。建库和授权由管理员在私有终端完成；不需要全局管理员权限。集成测试 `deployment/validate-mysql.mjs` 使用**独立、可丢弃**的 `options_theta_validation` 库，需另行授权，禁止指向生产库。

HTTP 默认绑定 `127.0.0.1:8892`，仅提供 GET：`/api/status`、`/api/history`、`/api/latency`。可通过自己的 SSH 配置转发：

```sh
ssh -N -L 127.0.0.1:9793:127.0.0.1:8892 YOUR_SSH_ALIAS
```

随后访问 `http://127.0.0.1:9793/`。不要将无身份验证的状态端口直接暴露公网。

Telegram：`/options /positions /pnl /risk /latency /pause /resume /setpaper 金额`。暂停只停止新开仓，继续管理持仓；改本金必须空仓，并创建新账本版本，不删除历史。

## 代码地图与验证

- `src/market.mjs`、`src/network.mjs`：行情、时钟估计、连接复用、限频与重连。
- `src/math.mjs`、`src/strategy.mjs`：Greeks、波动率、四腿候选、数量与风险预算。
- `src/paper.mjs`：保护腿优先的模拟执行、退出与恢复。
- `src/store.mjs`：事务、幂等、持久化延迟、归档配额。
- `src/engine.mjs`、`src/telegram.mjs`：扫描、人工控制、日报和消息队列。
- `tests/`：支付函数、风险预算、状态机、保护失败、乱序/超时、持仓控制等确定性测试。

测试通过不等于策略盈利。需要至少 14 天和 30 组完整组合观察，统计失败组损失、费后收益、回撤、保证金利用率及双倍费/滑点压力测试。样本不足不自动放宽条件。可见深度模拟不包含真实排队优先级或撮合保证。

## 脱敏范围

这是独立的脱敏源码快照，不包含原 Git 历史、真实余额、交易记录、服务器地址、SSH 密钥、API/Telegram 凭据、数据库或私人迁移脚本。公开示例中的 100U 是试验参数，不是收益证明。原运行环境与本仓库相互独立。

公开副本更新了 MySQL/WebSocket 依赖以处理发布时发现的安全告警；没有修改交易策略。已运行确定性测试；原部署环境的 MySQL 集成验证不应被视为本副本依赖更新后的线上验收。

## 参考

- [Binance Options 文档](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/market-data)
- [期权账户接口](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/account)
- [铁鹰/卖方组合策略基础](https://www.optionseducation.org/strategies/all-strategies/short-condor)
