# Fixed HTTPS snapshot service / 固定 HTTPS 快照服务

The service is included as `lib/share-service.js`. It is disabled by default and is started separately from Harness. It exposes documents and selected attachments, with no execution or Host RPC endpoint. Nothing in plugin installation starts or deploys it.

服务随本地包提供，入口为 `lib/share-service.js`。默认关闭，与 Harness 独立启动；只提供固定文档和明确选择的附件，无执行入口。安装插件不会启动或部署服务。

## Operator setup / 运维配置

Provide an HTTPS certificate and key, an empty private data directory, and your own publishing token of at least 32 characters through `DSH_SHARE_PUBLISH_TOKEN`. The service does not generate persistent credentials. Set `DSH_SHARE_PORT` if 8443 is unsuitable. `DSH_SHARE_BIND` defaults to `127.0.0.1`; exposing it publicly is a separate operator deployment action.

由运维人员提供证书、私钥、私有数据目录，并通过 `DSH_SHARE_PUBLISH_TOKEN` 提供至少 32 字符的发布凭据。服务不生成持久凭据。`DSH_SHARE_PORT` 默认 8443，`DSH_SHARE_BIND` 默认 `127.0.0.1`。公网部署需另行配置。

```text
node lib/share-service.js <data-directory> <key.pem> <cert.pem>
```

Configure the plugin row with `shareEnabled: true`, `shareServiceUrl: https://your-service-origin`, and `shareTokenEnv` naming the environment variable holding the publishing token. `shareCaFile` optionally supplies a private CA certificate. The URL must be an HTTPS origin; TLS verification is always enabled, redirects are refused, and writes are never automatically retried after an uncertain response.

插件配置项：`shareEnabled: true`、`shareServiceUrl`（HTTPS 服务源地址）、`shareTokenEnv`（存放凭据的环境变量名称）；自签或私有 CA 可额外设置 `shareCaFile`。TLS 校验始终启用，禁止重定向；结果不确定时不自动重复上传。

## Publishing and revocation / 发布与撤销

1. `conductor_share` with `action: preview`, a task ID and optional selected `attachmentIds` persists the exact document, byte content and SHA-256 digest. Inspect its document and inclusion/exclusion list.
2. After explicit user confirmation, call `action: publish` with that `snapshotId`, `confirmed: true`, and a stable `operationId`. A later task change cannot alter the preview. Default lifetime is seven days; the service accepts at most 365 days and an 8 MiB serialized payload.
3. On an uncertain upload, retry the same operation identity to reconcile the service receipt. A missing receipt remains unknown; it does not create another public URL.
4. `action: revoke` requires the task's current controller and an acknowledged server revocation. Future document and attachment retrieval is refused. Previously downloaded copies cannot be recalled.

1. `preview` 持久化精确文档、附件字节与摘要，先检查内容和排除项。
2. 用户明确确认后，使用原 `snapshotId` 和稳定 `operationId` 发布；后续任务变化不会进入该快照。默认有效期七天，上限 365 天，序列化请求上限 8 MiB。
3. 上传回执不确定时，同 ID 重试只查询远端回执；查询不到即保留 unknown，不新增公开链接。
4. `revoke` 只允许当前控制者操作，服务端确认后才记录撤销。未来访问停止，已下载副本无法召回。

Public paths are `/s/<opaque-token>` and `/s/<opaque-token>/attachments/<artifactId>`. Authenticated management uses `PUT`, `GET`, and `DELETE /api/snapshots/<shareId>`. Storage uses immutable JSON snapshots and separate durable revocation markers. Back up the whole data directory; deleting revocation markers would invalidate the revocation history. Expiry is checked on every retrieval and requires no cleanup timer.

公开路径为文档 `/s/<随机令牌>` 与附件子路径；管理接口需 Bearer 认证。数据目录包含不可覆盖的快照和独立撤销标记，备份应覆盖整个目录，不可单独删除撤销标记。每次读取检查过期状态，不依赖清理任务。

## Verification / 验证

`npx vitest run tests/share-integration.spec.ts` uses a temporary self-signed certificate, actual HTTPS sockets and filesystem restart. It checks fixed Unicode/binary bytes, authenticated uploads, immutable replay, expiry, durable revocation, current-controller authorization and lost-response reconciliation. Temporary services and certificate directories are closed and removed after tests. This is local integration evidence, not a public deployment or penetration-test certification.

上述命令使用临时证书、实际 HTTPS 连接和文件系统重启，验证中文与二进制字节、认证、不可覆盖性、过期、撤销、控制权与丢回执恢复；完成后停止服务并清理测试目录。它证明本地集成行为，不代表已经公开部署。
