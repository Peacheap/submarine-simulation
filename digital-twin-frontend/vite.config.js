import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true, // 同 WiFi 其他机器可用本机局域网 IP 访问
    port: 5173,
    proxy: {
      // /mw 含 REST 与 /mw/ws/results，必须开 ws，否则故障回传 WS 连不上
      '/mw': { target: 'http://127.0.0.1:9090', changeOrigin: true, ws: true },
      '/mock': { target: 'http://127.0.0.1:9090', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:9090', ws: true, changeOrigin: true },
    },
  },
})

