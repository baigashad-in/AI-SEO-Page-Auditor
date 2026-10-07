import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // playwright-core is only used server-side to connect to the TinyFish
  // remote browser over CDP. Keep it out of the bundle.
  serverExternalPackages: ["playwright-core"],
};

export default nextConfig;
