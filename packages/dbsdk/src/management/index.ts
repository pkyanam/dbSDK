/**
 * Public surface of the management plane (`dbsdk/management`).
 *
 * The user brings their own provider credential (Supabase PAT, Neon API key, or a third-party
 * adapter's equivalent) and gets one stable verb set — create / list / get / update / delete /
 * wait — over normalized resources. There is no central dbSDK backend and no credential proxy.
 *
 * @example
 * ```ts
 * import { createManagement } from 'dbsdk/management';
 * import { neonManagement } from 'dbsdk/management/neon';
 *
 * const management = createManagement({
 *   adapter: neonManagement({ apiKey: process.env.NEON_API_KEY! }),
 * });
 * const result = await management.create({ kind: 'project', name: 'my-app' });
 * const project = await management.wait(result, { timeoutMs: 120_000 });
 * ```
 */

export { createManagement, describeManagementCapabilities } from './core.js';
export type { ManagementCapabilityDescriptor } from './core.js';
export {
  ManagementError,
  isManagementError,
  normalizeManagementError,
} from './errors.js';
export type { ManagementErrorCode, ManagementErrorOptions } from './errors.js';
export {
  createManagementHttp,
  redactRecord,
  redactText,
  SECRET_KEYS,
} from './http.js';
export type {
  ManagementHttp,
  ManagementHttpConfig,
  ManagementHttpRequest,
  ManagementHttpResponse,
} from './http.js';
export type {
  CreateBranchSpec,
  CreateCustomSpec,
  CreateDatabaseSpec,
  CreateProjectSpec,
  CreateResourceSpec,
  FetchLike,
  KnownManagementProviderId,
  KnownManagementResourceKind,
  ManagementActionOptions,
  ManagementAdapter,
  ManagementAdapterCapabilities,
  ManagementCallOptions,
  ManagementClient,
  ManagementConnectionInfo,
  ManagementConnectionInput,
  ManagementDeleteResult,
  ManagementListQuery,
  ManagementOperation,
  ManagementOrganization,
  ManagementPage,
  ManagementProviderId,
  ManagementRegion,
  ManagementResource,
  ManagementResourceKind,
  ManagementScope,
  ManagementSecret,
  ManagementStatus,
  ManagementWriteResult,
  ResetCredentialOptions,
  ResourceRef,
  UpdateResourceSpec,
  WaitOptions,
  WaitTarget,
} from './types.js';
export type { EvidenceLevel } from '../types.js';
