import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), react()],
  build: {
    sourcemap: false, // eliminates loader.js.map 404 in DevTools
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3004', changeOrigin: true },
      '/ws':  { target: 'ws://localhost:3004',  ws: true, changeOrigin: true },
    },
  },
  appType: 'spa',
})