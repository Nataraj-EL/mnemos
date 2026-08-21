import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins: ['127.0.0.1:3000', 'localhost:3000', '127.0.0.1', 'localhost'],
  webpack: (config, { dev }) => {
    if (dev) {
      config.output.devtoolModuleFilenameTemplate = 'webpack:///[resource-path]';
      config.output.devtoolFallbackModuleFilenameTemplate = 'webpack:///[resource-path]?[hash]';
    }
    return config;
  }
};

export default nextConfig;
