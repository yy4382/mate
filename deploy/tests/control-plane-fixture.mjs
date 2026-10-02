// Test-only entrypoint. All application code and dependencies come from the image.
// The only injected dependency is the external model's HTTP/SSE endpoint.
import { startControlPlane } from "/opt/mate/apps/control-plane/dist/main.js";

startControlPlane(
  8787,
  undefined,
  {},
  {
    modelForRun: (model) => ({ ...model, baseUrl: process.env.MATE_TEST_PROVIDER_URL }),
  },
);
