export function releaseChildAdvisories(child: Record<string, unknown>): Record<string, unknown>[];
export function evaluateWindowsNodeChildPolicy(input: { child: Record<string, unknown> }): {
  advisoryJobs: Record<string, unknown>[];
  advisoryFailureAllowed: boolean;
  blockingJobs: Record<string, unknown>[];
};
