# 安全观看、重新订阅与部署 WSS

目标：用经过认证的 HTTPS/WSS 观看同一个 Simulation Session，并在 Viewer 断线后恢复当前实验。先完成[独立录制](recording.md)，保留 Lab、Installation 和 GLB。Synthetic 产生确定性运动，不计算 Newton 物理。

本章从仓库根目录运行。使用指定版本的 Node 和 pnpm。准备一个独立 Python 环境：

```bash
python3 -m venv .scratch/secure-motion-python
.scratch/secure-motion-python/bin/python -m pip install -r tools/synthetic-motion/requirements.txt
```

## 先运行可信本地 TLS 旅程

安装 Chromium 后运行完整的隔离旅程：

```bash
pnpm exec playwright install --with-deps chromium
MOTION_E2E_PYTHON="$PWD/.scratch/secure-motion-python/bin/python" node scripts/e2e-wss.mjs
```

Supervisor 构建实际服务与 Web，生成临时 CA、证书和密钥，再运行真实 HTTPS/WSS。它使用独立 PGlite 目录、可靠 Recording、Python 来源和 Chromium。没有证书错误忽略开关。

Linux 需要 OpenSSL 和 NSS 工具。系统缺少 `certutil` 时，Supervisor 将 `libnss3-tools` 提取到本次临时目录。它只向用户 NSS 库登记一个带唯一名称的 CA。结束或中断时，先停止本次消费者，再核对指纹并只删除该 CA；其他证书与数据库保留。

预期结果包括两个真实 3D Viewer、重新签票恢复、暂停后加入、Reset 新会话、拒绝时零映射/帧泄漏、配额释放和撤权。终端给出资源 ledger 路径。失败后检查该 ledger；Supervisor 异常终止时运行：

```bash
node scripts/e2e-wss.mjs --recover <owned-resources.json>
```

路径必须是该次 WSS Supervisor 的 ledger。恢复拒绝仍活动的 owner，保留身份无法确认的资源。该旅程只验证本地 TLS、安全和恢复；它不证明公网路由、WAN 延迟或三个不同主机运行。

## 在一个监听器上启用 HTTPS/WSS

准备对入口域名有效的 PEM 证书链与私钥。浏览器和 Python 必须信任其 CA，并验证主机名。用前章数据目录构建和启动：

```bash
pnpm build
APP_ORIGIN=https://lab.example.com:3443 \
FILE_PUBLIC_ORIGIN=https://lab.example.com:3443 \
LAB_WORD_HOST=0.0.0.0 SERVER_PORT=3443 \
LAB_WORD_TLS_CERT=/absolute/path/fullchain.pem \
LAB_WORD_TLS_KEY=/absolute/path/private-key.pem \
LAB_WORD_SYNTHETIC_SESSION=true LAB_WORD_SYNTHETIC_MANAGED=false \
LAB_WORD_MOTION_GRACE_MS=60000 \
LAB_WORD_DATA_DIR=.scratch/session-tutorial-data \
LAB_WORD_WEB_DIR="$PWD/apps/web/dist" pnpm start
```

替换域名、证书路径和端口。证书 SAN 必须匹配该域名。私钥文件只供服务 owner 读取。这里用已有的 60 秒来源启动宽限便于手动教学；自动部署可以使用默认 5 秒。票据仍为 30 秒，WS 认证仍为 3 秒，Recording ACK 期限不变。

服务在同一个 Node 监听器上处理 HTTP、SSE、Motion 和 Recording upgrade。证书和密钥必须成对配置，`APP_ORIGIN` 必须为 HTTPS。默认仍为回环 HTTP；plaintext Motion 只允许实际 loopback 对端。调用者的 forwarded/proto 头不能建立 TLS 信任。Motion fixture 继续只用于回环测试。

## 用独立机器身份启动外部来源

1. 打开该 HTTPS 入口，以 Member 登录前章的 Lab。
2. 从 Installation 列表取得 Lab UUID 和 Installation UUID。
3. 将下面的完整源码粘贴到浏览器 Console。

<<< ../examples/secure-motion.js

4. 创建独立机器和固定 Session：

```js
const external = await startExternalSynthetic(
  '<lab-uuid>',
  '<installation-uuid>',
);
console.log(external.session.id, external.machine.machine.id);
```

这会写入机器、Session、固定快照和初始 Recording。保存两个 UUID。从受保护的响应取得 `external.machine.credential`，保持私密。不要把凭据放入 URL、命令参数或日志。

5. 在外部 Python 主机运行以下命令。隐藏输入时粘贴机器凭据：

```bash
read -r -s -p 'Machine credential: ' motion_machine_credential
printf '\n'
printf '%s\n' "$motion_machine_credential" | .scratch/secure-motion-python/bin/python tools/synthetic-motion/remote.py \
  --server https://lab.example.com:3443 --lab <lab-uuid> \
  --session <session-uuid> --machine <machine-uuid>
unset motion_machine_credential
```

私有 CA 环境可在 Python 命令前设置 `SSL_CERT_FILE=/absolute/path/ca.pem`。不要关闭证书或主机名验证。Python 只发起出站连接，不提供公网监听端口。

机器凭据用于 HTTPS admission。服务为同一个 Session、lease 和 epoch 返回两个短期票据。Python 分别连接 Motion 与可靠 Recording，先确认持久第一帧，再进入运行。WS 不使用浏览器 Cookie 或全 Lab Agent key。

6. 在两个已授权浏览器打开同一 Lab，等待**正在运行**和**运动已连接**。
7. 将一个浏览器断网，再恢复网络。它重新签票、取得映射和完整 Snapshot。
8. 点击 **Pause**，再打开一个 Viewer。位姿和仿真时间保持冻结。
9. 点击 **Reset**。旧会话和录制结束，新会话重新准入。

外部来源不会自动重连或重放控制。Reset 后用新 Session UUID 显式启动新的来源；旧 lease、epoch 和票据不能继续发布。`Stop` 正常结束实验。来源失联、机器失效或录制故障会中断实验，保留有效录制前缀。

## 检查权限和恢复边界

Viewer 通过现有 Cookie/CSRF 或有 `lab:full` 的 Agent 请求观看票据。票据随机、Session 绑定、一次性且有效 30 秒。首条 WS HELLO 同时提交票据和期望 scene hash。通过验证前不发送私有映射或运动。

已有 Viewer 的身份和机器/lease 有效性每秒复查。验证结果最多保留 4 秒，超过期限会关闭连接。撤权后不能通过新票据恢复。浏览器只对暂时网络错误自动重试，最多连续六次；明确拒绝、场景错误和结束会话会停止重试。切换用户、Lab 或 Session 会取消旧请求与连接。

| 限制                                     | 当前上限         |
| ---------------------------------------- | ---------------- |
| 同账号活动 Motion Viewer                 | 8                |
| 同账号 / 同 Session 待消费 Motion ticket | 16 / 32          |
| 同 Session Viewer / 两种 WS 总连接       | 64 / 128         |
| Motion + Recording 待消费 ticket 总数    | 256              |
| WS 入站消息 / HELLO                      | 64 KiB / 16 KiB  |
| Viewer 待发送快照                        | 一个可替换槽     |
| Viewer WS 背压软 / 硬阈值                | 64 KiB / 256 KiB |
| 持续背压断开期限                         | 2 秒             |

这些限制独立于 HTTP 对端限流。15/30 Hz 只改变该 Viewer 的分发频率。慢 Reader 不改变来源采样、其他 Viewer 或可靠 Recording。

用错误 Origin、重复票据或错误 scene hash 连接，预期没有映射和帧。实际撤销一个 Agent key 后，其已有订阅终止；另一个有效 Member 继续观看。再按[录制检查](recording.md)读取有效前缀和完整性，不用直播缓存推断历史。

## LAN、私网和公网入口

LAN 可以直接使用 Node 的 HTTPS/WSS 监听器和受信任证书。Tailscale 提供私网路由；仍使用有效 HTTPS/WSS 证书和精确 `APP_ORIGIN`。它不改变成员权限或机器身份。

公网反向代理可以代理到受保护的 Node TLS upstream。例如部署方管理的 Nginx：

```nginx
location / {
  proxy_pass https://127.0.0.1:3443;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host lab.example.com;
  proxy_ssl_server_name on;
  proxy_ssl_name lab.example.com;
  proxy_ssl_verify on;
  proxy_ssl_trusted_certificate /absolute/path/ca-bundle.pem;
  proxy_read_timeout 75s;
}
```

公网端也必须配置有效 HTTPS 证书。将 `APP_ORIGIN` 和 `FILE_PUBLIC_ORIGIN` 设为实际浏览器入口。Node 不信任代理头来推导 TLS 或客户端身份；HTTP 限流看到代理的实际 TCP 对端。

Cloudflare Tunnel 可使用 `service: https://localhost:3443`，并配置 `originRequest.originServerName: lab.example.com` 和受信任 `caPool`。保留 origin 证书验证。Tunnel 只提供入口，不运行求解器或 Gateway。实际跨主机、私网和公网路由需要在部署环境单独验收。

配置来自[运行 parser](../../apps/server/src/config.ts)。安全接入由[共享传输检查](../../apps/server/src/transport.ts)、[Motion](../../apps/server/src/motion-ws.ts)和[Recording](../../apps/server/src/recording-ws.ts)负责。状态和鉴权归[Session](../../packages/server/src/lab/sessions/service.ts)；恢复归[Viewer](../../packages/views/src/lab/use-simulation-session.ts)。下一步继续[空间工作台](spatial-workbench.md)。
