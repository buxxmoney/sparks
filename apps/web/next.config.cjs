/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@sparks/server"],
  experimental: {
    serverComponentsExternalPackages: ["@sparks/db"],
  },
};

module.exports = nextConfig;
