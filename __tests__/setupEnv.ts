// __test__/setupEnv.ts
// Load environment variables for tests

export default async () => {
  // Attempt to load Next.js env config, but don't fail if unavailable
  try {
    // For Next.js projects, try to use loadEnvConfig
    const { loadEnvConfig } = await import("@next/env")
    const projectDir = process.cwd()
    loadEnvConfig(projectDir)
  } catch (error) {
    // If @next/env is not available or fails, it's okay
    // Environment variables should already be set, or use dotenv as fallback
    console.log("[setupEnv] Note: @next/env not available, skipping Next.js env config")

    // Try dotenv as fallback
    try {
      const path = require("path")
      const dotenv = require("dotenv")
      const dotenvPath = path.resolve(process.cwd(), ".env")
      dotenv.config({ path: dotenvPath })
    } catch (e) {
      // dotenv also not available, environment vars should be set separately
    }
  }
}
