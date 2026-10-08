import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const root = process.cwd()

function copyRunnerPlugin(): Plugin {
  return {
    name: 'copy-python-runner',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'runner.py',
        source: readFileSync(resolve(root, 'packages/core/src/plugins/runner.py'), 'utf8')
      })
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyRunnerPlugin()],
    resolve: {
      alias: {
        '@proxy/shared': resolve(root, 'packages/shared/src/index.ts'),
        '@proxy/core': resolve(root, 'packages/core/src/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: 'packages/ui',
    plugins: [tailwindcss()],
    esbuild: { jsx: 'automatic' },
    resolve: {
      alias: {
        '@proxy/shared': resolve(root, 'packages/shared/src/index.ts')
      }
    },
    build: {
      rollupOptions: {
        input: resolve(root, 'packages/ui/index.html')
      }
    }
  }
})
