/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@sparks/server", "@sparks/api"],
  experimental: {
    serverComponentsExternalPackages: ["@sparks/db"],
  },
};

module.exports = nextConfig;
