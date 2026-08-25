import type { ProviderHandlerContext, ProviderOperationResult } from "../../../../packages/platform/provider-sdk/src/index.js";

export interface RoadCoverageEngine {
  validate(input: unknown, context: ProviderHandlerContext): Promise<ProviderOperationResult<unknown>>;
  selectObligations(input: unknown, context: ProviderHandlerContext): Promise<ProviderOperationResult<unknown>>;
  plan(input: unknown, context: ProviderHandlerContext): Promise<ProviderOperationResult<unknown>>;
  verify(input: unknown, context: ProviderHandlerContext): Promise<ProviderOperationResult<unknown>>;
  expandGeoJson(input: unknown, context: ProviderHandlerContext): Promise<ProviderOperationResult<unknown>>;
}
