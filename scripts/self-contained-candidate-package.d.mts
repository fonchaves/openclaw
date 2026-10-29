export function createSelfContainedCandidatePackage(params: {
  packageDir: string;
  registryDir?: string;
  outputDir: string;
  expectedSourceSha: string;
  expectedVersion: string;
  expectedSha256: string;
}): { bundled: string[]; sha256: string; version: string };
