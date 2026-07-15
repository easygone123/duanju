import type { NextConfig } from "next";
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n.ts');
const lowMemoryBuild = process.env.NEXT_BUILD_LOW_MEMORY === '1';

const nextConfig: NextConfig = {
  // Docker low-memory builds run typecheck and lint as explicit serial steps first.
  // Next 15 的 allowedDevOrigins 是顶层配置，不属于 experimental
  allowedDevOrigins: [
    'http://192.168.31.218:3000',
    'http://192.168.31.*:3000',
  ],
  ...(lowMemoryBuild ? {
    eslint: { ignoreDuringBuilds: true },
    typescript: { ignoreBuildErrors: true },
    experimental: {
      cpus: 1,
      webpackMemoryOptimizations: true,
    },
  } : {}),
};

export default withNextIntl(nextConfig);
