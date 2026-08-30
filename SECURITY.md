# Security Policy

## Reporting a Vulnerability

请勿在公开 issue 中提交安全漏洞。请通过以下任一渠道私密报告：

- 在本仓库创建 **Private security advisory**（GitHub: Security → Report a vulnerability）
- 或直接向维护者发送邮件（见仓库主页）

## Scope

本项目涉及企业微信回调的签名校验与 AES 解密、应用凭据（corpsecret / EncodingAESKey）与
access_token 管理。任何与以下内容相关的问题都在本政策范围内：

- 签名校验绕过 / 常数时间比较缺失
- 加解密实现缺陷（密钥派生、PKCS7 填充、长度越界）
- 凭据或 access_token 泄漏（日志、错误信息、响应体）
- 输入导致的资源耗尽（超大请求体、超长文本、队列泛滥）
- 越权访问回调端点

## 安全承诺（默认行为）

1. 回调端点默认只绑定 `127.0.0.1`，公网暴露必须通过 HTTPS 反向代理/隧道，且由你自行保证；
2. 所有企微凭据支持通过环境变量注入，绝不允许写入日志；
3. 请求体、消息文本、队列深度均有默认上限；
4. 签名比较使用常数时间算法；AES 密钥长度与 PKCS7 填充做严格校验；
5. 该插件会把消息文本作为任务交给 dsh agent 执行——请把 `workspace` 指向受控目录，
   不要使用 `danger-full-access` 沙箱，除非你完全清楚后果。
