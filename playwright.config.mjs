import { defineConfig, devices } from "@playwright/test";

const serverlessExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30000,
  retries: 1,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: process.env.ZEVANORY_BASE_URL || "https://zevanory.api.br",
    launchOptions: serverlessExecutablePath ? {
      executablePath: serverlessExecutablePath,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    } : undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-1366",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1366, height: 768 },
      },
    },
    {
      name: "desktop-1920",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1080 },
      },
    },
  ],
});
