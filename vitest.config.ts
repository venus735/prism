import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@proxy/shared': resolve(root, 'packages/shared/src/index.ts'),
      '@proxy/core': resolve(root, 'packages/core/src/index.ts')
    }
  },
  test: {
    server: {
      deps: {
        // 插件加载用临时目录中的 ESM 文件，?v= 查询串需要透传给 Node 原生 import 才能真正重新加载
        external: ['/var/folders/', '/private/var/folders/', '/tmp/']
      }
    }
  }
})
