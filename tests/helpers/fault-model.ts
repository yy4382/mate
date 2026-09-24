/**
 * Identity for the synthetic worker provider the fault fixture installs. Kept in its own module so
 * the test can import it without loading the fixture entrypoint, which starts a worker.
 */
export const providerId = "synthetic-provider";
