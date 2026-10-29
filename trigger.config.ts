import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // Project ref from cloud.trigger.dev → your project → Project settings (starts with "proj_")
  project: "proj_REPLACE_ME",
  dirs: ["./src/trigger"],
  maxDuration: 600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 5000,
      maxTimeoutInMs: 60_000,
    },
  },
});
