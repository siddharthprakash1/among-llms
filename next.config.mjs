/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Type errors still fail the build; we just don't require an ESLint config.
  eslint: { ignoreDuringBuilds: true },
  // Opt-in: standalone needs symlinks, which break plain Windows builds.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" } : {}),
  // No outputFileTracingExcludes for ./data: Next matches those globs as substrings, so
  // "data/**" also drops next/dist/lib/metadata/** and the standalone server cannot boot.
  // .dockerignore keeps data/ out of the image instead.
};

export default nextConfig;
