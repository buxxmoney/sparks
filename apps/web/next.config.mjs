/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@sparks/server", "@sparks/api"],
  // Renamed from experimental.serverComponentsExternalPackages in Next 15.
  serverExternalPackages: ["@sparks/db"],
  // The auth pages live under /auth/*. Bare paths (/login, /signup, ...) are what people
  // and old links naturally type; without these they hit a raw 404 rendered inside the
  // app shell. Send them to the real page instead. Self-signup is disabled, so /signup
  // and friends land on login (matching /auth/signup's own redirect). Non-permanent (307)
  // so nothing is cached hard if these routes ever change.
  async redirects() {
    return [
      { source: "/login", destination: "/auth/login", permanent: false },
      { source: "/sign-in", destination: "/auth/login", permanent: false },
      { source: "/signin", destination: "/auth/login", permanent: false },
      { source: "/signup", destination: "/auth/login", permanent: false },
      { source: "/sign-up", destination: "/auth/login", permanent: false },
      { source: "/register", destination: "/auth/login", permanent: false },
      { source: "/forgot-password", destination: "/auth/forgot-password", permanent: false },
    ];
  },
};

export default nextConfig;
