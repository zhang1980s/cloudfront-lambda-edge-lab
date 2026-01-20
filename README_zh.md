# CloudFront 边缘函数对比实验

## 目标

构建一个实验环境，了解 Lambda@Edge 和 CloudFront Functions 如何与 CloudFront 配合，在边缘验证 HTTP 请求。使用两种方案实现相同的机器人检测逻辑，对比其能力、性能和适用场景。

## 需求

- 使用 HTTP 头中的两个安全字段验证请求是否来自机器人
- 验证使用 crypto/SHA256 函数
- 无效请求在边缘立即拒绝（返回 403 响应）

## 机器人验证设计

### HTTP 头

| 头字段 | 用途 | 示例值 |
|--------|------|--------|
| `X-Bot-Token` | 时间戳（Unix 纪元秒数） | `1737312000` |
| `X-Bot-Signature` | 使用共享密钥对 token 进行 HMAC-SHA256 哈希 | `a3f2b8c1d4e5...`（64字符十六进制字符串） |

### 验证逻辑

```
1. 提取头字段：
   - token = request.headers['X-Bot-Token']
   - signature = request.headers['X-Bot-Signature']

2. 如果任一头字段缺失 → 403

3. 计算预期签名：
   expectedSignature = HMAC-SHA256(token, SECRET_KEY).toHex()

4. 比较签名（常量时间比较）：
   - 如果 signature === expectedSignature → 允许请求
   - 如果不匹配 → 403 Forbidden

5. （可选）时间戳验证：
   - 如果 token 超过 5 分钟 → 拒绝，防止重放攻击
```

### 请求示例

**共享密钥：** `my-secret-key-2024`

**客户端请求：**
```bash
curl -H "X-Bot-Token: 1737312000" \
     -H "X-Bot-Signature: 7a8b9c0d1e2f..." \
     https://d123.cloudfront.net/cf-function/test.html
```

**服务端验证（伪代码）：**
```javascript
const expected = HMAC_SHA256(token, SECRET_KEY).toHex();
if (signature === expected) {
    // 允许请求通过
} else {
    // 返回 403 Forbidden
}
```

### 为什么使用 HMAC-SHA256？

- **HMAC**（基于哈希的消息认证码）比纯 SHA256 更安全
- 防止长度扩展攻击
- API 签名验证的行业标准

### 为什么使用两个字段而不是一个？

| 单一 Token | 双字段（Token + Signature） |
|------------|----------------------------|
| 静态的，被窃取后可永久重放 | 时间戳防止重放攻击 |
| 泄露后攻击者获得完全访问权限 | 密钥从不传输，只传输签名 |
| 易于暴力破解 | HMAC 计算成本高，难以伪造 |

双字段模式提供了**密钥持有证明**，而无需实际传输密钥。

### 实际应用场景

**1. 移动应用 API 保护**

公司有一个移动应用调用后端 API。他们希望确保只有合法应用（而非爬虫或逆向工程的客户端）可以访问 API。

```
应用生成：
- X-Bot-Token: 当前时间戳
- X-Bot-Signature: HMAC(timestamp, 内嵌在应用中的密钥)

服务器验证签名匹配 → 证明请求来自真实应用
```

**2. CDN 保护的内容分发**

流媒体服务希望防止未授权下载视频内容。只有官方播放器可以访问 CDN。

```
播放器请求视频：
- Token: session_id + timestamp
- Signature: 证明播放器拥有签名密钥

CloudFront 在边缘验证 → 在到达源站前阻止 wget/curl/爬虫
```

**3. API 网关限流绕过防护**

API 为付费合作伙伴提供更高的请求限制。合作伙伴签名请求以证明身份，而无需明文发送 API 密钥。

```
合作伙伴请求：
- X-Bot-Token: partner_id:timestamp
- X-Bot-Signature: HMAC 证明

防止攻击者伪造 partner_id 获取更高限额
```

**4. Webhook 认证**

服务 A 向服务 B 发送 webhook。服务 B 需要验证 webhook 确实来自服务 A（而非攻击者）。

```
来自服务 A 的 Webhook：
- X-Webhook-Timestamp: 发送时间
- X-Webhook-Signature: HMAC(payload + timestamp, shared_secret)

服务 B 验证 → 防止伪造的 webhook 注入
```

**5. IoT 设备认证**

IoT 设备与云端后台通信。每个设备在制造时烧录唯一密钥。

```
设备请求：
- X-Device-Token: device_id:timestamp
- X-Device-Signature: 证明设备拥有密钥

后端验证 → 阻止伪造的设备流量
```

## 实施计划

### 阶段 1：项目设置

**需要创建的文件：**
```
cloudfront-lambda-edge-lab/
├── README.md                    # 实验概述（更新现有）
├── cloudfront-function/
│   └── bot-validator.js         # CloudFront Function 代码
├── lambda-edge/
│   └── index.js                 # Lambda@Edge 处理程序
├── cdk/
│   ├── lib/
│   │   └── edge-lab-stack.ts    # CDK 堆栈
│   ├── bin/
│   │   └── app.ts               # CDK 应用入口
│   ├── package.json
│   └── cdk.json
└── test/
    └── test-requests.sh         # 测试脚本
```

### 阶段 2：CloudFront Function 实现

**文件：`cloudfront-function/bot-validator.js`**

- 使用 JavaScript Runtime 2.0
- 导入 Crypto 模块用于 SHA256
- 从 viewer request 读取 2 个安全头
- 计算哈希并验证
- 验证失败返回 403 响应
- 验证通过则放行请求

### 阶段 3：Lambda@Edge 实现

**文件：`lambda-edge/index.js`**

- Node.js 运行时
- 使用原生 crypto 模块进行 SHA256
- 与 CloudFront Function 相同的验证逻辑
- viewer-request 事件处理程序
- 返回 403 或允许通过

### 阶段 4：CDK 基础设施

**文件：`cdk/lib/edge-lab-stack.ts`**

- 创建 S3 存储桶作为源站（简单测试源）
- 创建 CloudFront 分配
- 部署 CloudFront Function
- 部署 Lambda@Edge 函数（us-east-1）
- 创建 2 个缓存行为来测试每种方案：
  - `/cf-function/*` → CloudFront Function 验证
  - `/lambda-edge/*` → Lambda@Edge 验证

### 阶段 5：测试与对比

**测试场景：**
1. 有效头 → 请求通过
2. 无效/篡改的头 → 403 Forbidden
3. 缺失头 → 403 Forbidden

**对比指标：**
- 延迟（CloudFront Functions 应该更快）
- 成本结构差异
- 代码复杂度
- 部署体验

## 关键差异

| 方面 | CloudFront Functions | Lambda@Edge |
|------|---------------------|-------------|
| 执行时间 | 亚毫秒级 | 毫秒级 |
| 扩展能力 | 每秒数百万请求 | 每区域约 10K/秒 |
| 部署区域 | 所有边缘节点 | us-east-1 然后复制 |
| 网络访问 | 否 | 是 |
| 最适合 | 简单、快速验证 | 复杂逻辑、外部调用 |

## 成本对比

### 定价模式

| 组件 | CloudFront Functions | Lambda@Edge |
|------|---------------------|-------------|
| **调用** | $0.10 / 百万次调用 | $0.60 / 百万次调用 |
| **计算** | 包含在调用价格中 | $0.00000625125 / 128MB-ms |
| **免费套餐** | 200万次调用/月 | 100万请求 + 400,000 GB-秒/月 |
| **时长计费** | 无（亚毫秒执行） | 按 1ms 计费（最少 1ms） |

### 成本示例（每月）

**场景：1 亿请求/月**

| 成本组件 | CloudFront Functions | Lambda@Edge (平均 5ms) |
|----------|---------------------|------------------------|
| 调用 | $10.00 | $60.00 |
| 计算 (128MB) | $0.00 | $3.13 |
| **总计** | **$10.00** | **$63.13** |

**场景：10 亿请求/月**

| 成本组件 | CloudFront Functions | Lambda@Edge (平均 5ms) |
|----------|---------------------|------------------------|
| 调用 | $100.00 | $600.00 |
| 计算 (128MB) | $0.00 | $31.26 |
| **总计** | **$100.00** | **$631.26** |

> **CloudFront Functions 便宜约 6 倍**，适用于简单请求验证场景。

### 何时 Lambda@Edge 成本合理

- 需要进行外部 API 调用（认证服务、数据库）
- 复杂处理需要超过 10KB 代码大小
- 响应体操作（CloudFront Functions 限制 2MB）
- 需要在 viewer request 中访问请求体
- 执行时间可能持续超过 1ms

## 运维对比

| 方面 | CloudFront Functions | Lambda@Edge |
|------|---------------------|-------------|
| **代码大小限制** | 10 KB | 1 MB (viewer) / 50 MB (origin) |
| **内存** | 固定 (最大 2MB) | 128 MB - 10,240 MB 可配置 |
| **超时** | < 1ms | 5 秒 (viewer) / 30 秒 (origin) |
| **运行时** | JavaScript (ECMAScript 5.1 + Runtime 2.0) | Node.js, Python |
| **部署** | 即时（秒级） | 分钟级（复制到所有边缘） |
| **版本管理** | 自动 | 需要手动版本管理 |
| **日志** | CloudWatch Logs（采样） | CloudWatch Logs（按区域） |
| **调试** | 有限（生产环境无 console.log） | 完整 CloudWatch 集成 |
| **IAM** | 不需要 IAM 角色 | 需要执行角色 + 信任策略 |
| **VPC 访问** | 否 | 否（边缘函数无法访问 VPC） |

### 运维考虑

**CloudFront Functions：**
- ✅ 更简单的部署和回滚
- ✅ 无冷启动
- ✅ 无版本管理开销
- ⚠️ 调试能力有限
- ⚠️ 严格的资源限制

**Lambda@Edge：**
- ✅ 完整的 Node.js/Python 生态系统
- ✅ 详细的 CloudWatch 指标（按区域）
- ✅ 可处理复杂业务逻辑
- ⚠️ 冷启动延迟（50-200ms）
- ⚠️ 需要版本/别名管理
- ⚠️ 日志分散在各区域
- ⚠️ 副本存在时无法删除函数（需等待约 30 分钟）

### 推荐矩阵

| 使用场景 | 推荐方案 |
|----------|---------|
| 头验证（本实验） | CloudFront Functions |
| URL 重写/重定向 | CloudFront Functions |
| 简单 A/B 测试 | CloudFront Functions |
| 带外部 API 的机器人检测 | Lambda@Edge |
| 带 token 验证的认证 | Lambda@Edge |
| 图片优化 | Lambda@Edge |
| 复杂响应操作 | Lambda@Edge |

## 验证步骤

1. 部署 CDK 堆栈
2. 使用有效头运行测试脚本 → 期望 200
3. 使用无效头运行测试脚本 → 期望 403
4. 对比 CloudWatch 指标中的延迟
5. 查看两个函数的日志

## 注意事项

- Lambda@Edge 必须部署在 us-east-1
- CloudFront Function 使用 Runtime 2.0 以支持 crypto
- 两种方案都在 viewer-request 阶段验证
