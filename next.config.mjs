/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Type errors still fail the build; we just don't require an ESLint config.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
