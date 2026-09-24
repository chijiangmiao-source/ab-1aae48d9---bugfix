# 多重测序条码子库审计

在浏览器内录入 **10–44 条**条码记录（等长、仅含 A/C/G/T、标识唯一；正整数优先权与距离阈值），
在 **Web Worker** 中精确求解满足汉明距离约束的最优子库。

## 审计规则

- 两条记录的互斥距离取全部 **正向 / 反向互补** 组合下的最小汉明距离
  （d(a,b) 与 d(a,rc(b))；另两项由等距性自动相等）。
- 最小距离 **低于双方阈值中的较大者** 即互斥（按双方更保守的要求执行）。
- 自身反向互补距离不足自身阈值的记录存在自冲突，**直接丧失入选资格**。
- 目标（双层最优）：
  1. 优先权总和 **最大**；
  2. 并列时记录数 **最多**。
- 输出：
  - 最大优先权总和与规范子库记录数；
  - **任意精度** 的双层最优同优方案数（BigInt，十进制展示）；
  - 基于全部最优方案，将每条记录判为 **必选 / 可选 / 从不选**；
  - 按输入次序“**选中优先**”逐位裁决的规范位向量（所有最优位向量中字典序最大者）。

## 求解方法

最大权独立集（n ≤ 44）。折半枚举（MITM，每半 ≤ 22）：一侧做子集最优 DP，
另一侧枚举全部独立集并合并；同时精确计数全部最优方案、统计各顶点出现次数以界定归属，
再用逐位相容性裁决规范代表。计算分批向事件循环让步，可随时取消。

非法输入、取消、以及旧任务的迟到消息都 **不会覆盖最近一次成功结论**（按任务 id 过滤）。

## 本地运行（无需 npm install，零运行时依赖）

```bash
node src/server/server.js          # 默认 http://localhost:8080，健康路径 /healthz
PORT=9090 node src/server/server.js
npm test                           # node --test
npm run verify                     # 代码测试 + 构建检查 + HTTP 冒烟（退出码报告成败）
```

## Docker

```bash
# 页面（宿主端口可用 WEB_PORT 配置，默认 8080）
docker compose up web
WEB_PORT=9090 docker compose up web

# 单次核验服务 verify：等待 web 健康后执行测试/构建/冒烟，退出码即成败
docker compose up --abort-on-container-exit --exit-code-from verify
```

## 目录结构

```
src/lib/optimizer.js   核心算法（序列工具、校验、建图、MITM 精确求解）
src/lib/protocol.js    Worker 消息协议与陈旧消息判定
src/web/               页面（index.html / styles.css / ui.js / worker.js）
src/server/server.js   零依赖静态服务器（含 /healthz）
test/                  单元 + 穷举对拍 + Worker 集成测试
scripts/verify.mjs     一次性核验流水线
```
