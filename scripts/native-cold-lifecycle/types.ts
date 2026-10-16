import type { NativeArchiveGeneration } from "../../lib/creative-decision-engine/native-evidence-archive";
import type { OwnedColdSession } from "../../lib/native-cold-session";
import type { ReplicaRequest,ReplicaAck } from "./replica";
import type { Sample } from "../native-storage-batch/http-proof";
export type ColdPhase="sampling"|"capturing"|"captured"|"restored"|"replicated"|"published"|
  "http_verified"|"retiring"|"retired"|"readback"|"complete"|"owner_attention";
export interface ColdUnitState {
  contract:"native-cold-unit-state.v1";businessId:string;jobRunId:string;purpose:string;generation:NativeArchiveGeneration;
  evaluations:number;contexts:number;sourceBuildId:string;sourceInventorySha256:string;sourceReviewSha256:string;
  startedAt:string;deadlineAt:string;phase:ColdPhase;session?:OwnedColdSession;
  capture?:{proofSha256:string;leafSha256:string;archiveBytes:number;parts:number;samples:Sample[];
    evaluations:number;contexts:number;encodedRows:number;capturedAt:string;rssBytes:number};
  restore?:{restored:boolean;frozenProofParity:boolean;plaintextRestoreDropped:boolean;completeOriginalCopiesMatch:boolean;
    privateBytes:number;privateFiles:number;restoredProofSha256:string;privateSocketOnly:boolean};
  capacityRequest?:ReplicaRequest;replicaRequest?:ReplicaRequest;replicaAck?:ReplicaAck;
  publication?:{rootSha256:string;publishedAt:string;previousRootSha256:string;existing:boolean};
  httpBefore?:{proofSha256:string;requests:number;observedAt:string;current:CurrentReadBaseline[]};
  httpAfter?:{proofSha256:string;requests:number;observedAt:string;current:CurrentReadBaseline[]};
  retirement?:{committed:boolean;preparedSha256:string;producerExclusionRelease:string};
  readback?:{exactUnitAbsent:boolean;retainedRootsFullBytesMatch:boolean;inputEvidence?:{match:boolean}};
  failure?:{code:string;sqlState:string|null;phase:ColdPhase;observedAt:string};
  measurements?:{before:Record<string,unknown>;after:Record<string,unknown>};
}
export interface CurrentReadBaseline {providerAccountId:string;adId:string;asOfDate:string;httpStatus:number;
  status:string|null;error:string|null;bodySha256:string;historicalAuthority:false}
export interface ColdControllerState {contract:"native-cold-controller.v1";
  cursor:{asOfDate:string;jobRunId:string}|null;active:{businessId:string;jobRunId:string;purpose:string}|null;
  nextEligibleAt:string|null;archivedOriginals:number;vetoes:unknown[];
  lastSuccess:Record<string,unknown>|null;lastFailure:Record<string,unknown>|null;
  reads:{businessId:string;observedAt:string;requests:number;downloadBytes:number}[];
  observations:{observedAt:string;databaseBytes:number;accountedBytes:number;appArchiveBytes:number;replicaAvailableBytes:number}[];
}
