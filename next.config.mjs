/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fully static export. The dashboard reads the committed reports at build time
  // and renders to plain HTML/CSS/JS under out/, so the deployed showcase needs
  // no server, no cluster, and no API key at runtime. Vercel serves the static
  // output directly.
  output: "export",
};

export default nextConfig;
