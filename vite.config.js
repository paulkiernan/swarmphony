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
    },
  };
});
