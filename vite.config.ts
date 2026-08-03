import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'
import path from 'path'

/**
 * 读取服务端 API Token（R8-2）。
 * token 由 server 首次启动时生成于 .novel-data/api-token；
 * 代理在转发每个 /api 请求时注入 x-api-token，前端代码无需感知密钥。
 * 文件尚不存在（启动瞬间竞态）时返回空串，该请求会 401，属可接受窗口。
 */
function readApiToken(): string {
  try {
    return fs
      .readFileSync(path.join(process.cwd(), '.novel-data', 'api-token'), 'utf-8')
      .trim()
  } catch {
    return ''
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 写配置/密钥时不要触发 Vite 整页刷新
    watch: {
      ignored: [
        '**/.novel-data/**',
        '**/server/data/**',
        '**/.secret',
        '**/config.json',
      ],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const token = readApiToken()
            if (token) proxyReq.setHeader('x-api-token', token)
          })
        },
      },
    },
  },
})
