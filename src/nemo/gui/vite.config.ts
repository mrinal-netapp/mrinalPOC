import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Get base path from environment variable, default to '/' for standalone mode
// When deployed behind a gateway, set VITE_BASE_PATH=/console (or appropriate path)
// Vite expects base path to end with / (except for root)
let basePath = process.env.VITE_BASE_PATH || '/'
if (basePath !== '/' && !basePath.endsWith('/')) {
  basePath = basePath + '/'
}

// https://vitejs.dev/config/
export default defineConfig({
  base: basePath,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 3000,
    proxy: {
      // config-service behind apigateway / nginx gateway
      '/config': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/workflow': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/agents': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/kb': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/analytics': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      // Bifrost cost/usage metrics (apigateway proxies PROMETHEUS_URL → /prometheus)
      '/prometheus': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // React core libraries - must be in the same chunk and loaded first
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          // Fluent UI (large UI library)
          'fluentui-vendor': [
            '@fluentui/react-components',
            '@fluentui/react-icons',
          ],
          // ReactFlow (large graph library)
          'reactflow-vendor': ['reactflow'],
          // Markdown rendering
          'markdown-vendor': ['react-markdown', 'remark-gfm'],
          // State management
          'zustand-vendor': ['zustand'],
          // HTTP client
          'axios-vendor': ['axios'],
        },
      },
    },
    // Increase chunk size warning limit to 800kb (Fluent UI and ReactFlow are large libraries)
    chunkSizeWarningLimit: 800,
    // Ensure proper module resolution
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true,
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-router-dom'],
    esbuildOptions: {
      target: 'es2020',
    },
  },
})

