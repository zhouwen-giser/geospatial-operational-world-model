import {
  createH3AnalysisProvider,
  createH3InteractiveProvider,
  H3_ANALYSIS_OPERATION_IDS,
  H3_INTERACTIVE_OPERATION_IDS,
  H3_TOOLKIT_SOURCE_LOCK,
  lockedAttestation,
  type H3OperationId,
  type H3ToolkitUpstream
} from "../../packages/integrations/h3-toolkit-bridge/src/index.js";

const upstream: H3ToolkitUpstream = {
  attestation: lockedAttestation("TEST_DOUBLE"),
  supportedOperations: [...H3_INTERACTIVE_OPERATION_IDS, ...H3_ANALYSIS_OPERATION_IDS],
  async execute(operationId: H3OperationId): Promise<never> {
    throw new Error(`manifest snapshot must not execute ${operationId}`);
  },
  async readiness() {
    return {
      ready: true,
      reasons: [],
      sourceGitCommit: H3_TOOLKIT_SOURCE_LOCK.sourceGitCommit,
      toolkitVersion: H3_TOOLKIT_SOURCE_LOCK.toolkitVersion,
      engineVersion: H3_TOOLKIT_SOURCE_LOCK.engineVersion
    };
  }
};

process.stdout.write(JSON.stringify({
  interactive: createH3InteractiveProvider({ upstream }).runtime.manifest,
  analysis: createH3AnalysisProvider({ upstream }).runtime.manifest
}));
