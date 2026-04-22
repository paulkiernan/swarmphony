import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const isLib = mode === 'lib';

  return {
    build: isLib
      ? {
          lib: {
            entry: 'lib/index.js',
            name: 'Swarmphony',
            fileName: 'swarmphony',
            formats: ['es'],
          },
          rollupOptions: {
            external: ['three'],
            output: {
              globals: { three: 'THREE' },
            },
          },
        }
      : {
          outDir: 'dist',
        },
    server: {
      open: true,
      proxy: {
        '/stream': {
          target: 'https://ice2.somafm.com',
          changeOrigin: true,
          rewrite: (path) => '/defcon-128-mp3',
        },
      },
    },
    preview: {
      allowedHosts: true,
      proxy: {
        '/stream': {
          target: 'https://ice2.somafm.com',
          changeOrigin: true,
          rewrite: (path) => '/defcon-128-mp3',
        },
      },
    },
  };
});
