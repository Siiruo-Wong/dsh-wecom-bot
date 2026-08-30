import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 用 IP 字面量代替 'localhost':部分机器/代理环境下 DNS 解析不到 localhost,
  // 会导致 vitest 内部 vite 服务器启动失败(getaddrinfo ENOTFOUND localhost)
  server: {
    host: '127.0.0.1',
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
