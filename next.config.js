/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    domains: [],
  },
  // Exclude src directory from Next.js processing since we're using app directory
  pageExtensions: ['ts', 'tsx', 'js', 'jsx'],
}

export default nextConfig


