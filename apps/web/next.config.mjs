/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@sparks/server", "@sparks/api"],
  // Renamed from experimental.serverComponentsExternalPackages in Next 15.
  serverExternalPackages: ["@sparks/db"],
};

export default nextConfig;
