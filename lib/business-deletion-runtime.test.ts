import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({capacity:vi.fn(),work:vi.fn(),lane:vi.fn()}));
vi.mock("@/lib/sync/db-growth-fence",async original=>({...await original<object>(),evaluateDbGrowthFence:mocks.capacity}));
vi.mock("@/lib/sync/global-kill-switch",()=>({assertSyncLaneEnabled:mocks.lane}));
vi.mock("@/lib/business-deletion-jobs",()=>({runBusinessDeletionWorkerTick:mocks.work}));
const {createBusinessDeletionProcessor,runAdmittedBusinessDeletionTick,startBusinessDeletionProcessor}=await import("./business-deletion-runtime");
beforeEach(()=>{vi.resetAllMocks();mocks.capacity.mockResolvedValue({allowed:true,overridden:false,physical:{admitted:true}});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe("web-owned durable erasure admission",()=>{
  it.each(["database_budget_exceeded","table_budget_exceeded"])("permits only erasure through a measured %s with fresh physical proof",async reason=>{
    mocks.capacity.mockResolvedValue({allowed:false,reason,overridden:false,physical:{admitted:true}});
    await runAdmittedBusinessDeletionTick();expect(mocks.work).toHaveBeenCalledTimes(1);
  });
  it.each([
    {allowed:false,reason:"physical_free_space_low",overridden:false,physical:{admitted:false}},
    {allowed:false,reason:"measurement_invalid",overridden:false,physical:{admitted:true}},
    {allowed:false,reason:"database_budget_exceeded",overridden:false,physical:null},
    {allowed:true,reason:"override",overridden:true,physical:{admitted:true}},
  ])("refuses unsafe or unknown capacity before claiming a job",async decision=>{
    mocks.capacity.mockResolvedValue(decision);await expect(runAdmittedBusinessDeletionTick()).rejects.toThrow();expect(mocks.work).not.toHaveBeenCalled();
  });
  it("keeps the assignment kill switch authoritative",async()=>{
    mocks.lane.mockImplementation(()=>{throw Error("disabled");});await expect(runAdmittedBusinessDeletionTick()).rejects.toThrow("disabled");
    expect(mocks.capacity).not.toHaveBeenCalled();expect(mocks.work).not.toHaveBeenCalled();
  });
  it("does not overlap a long operation and stops dispatch without cancelling an active transaction",async()=>{
    vi.useFakeTimers();let finish!:()=>void;const work=vi.fn(()=>new Promise<void>(r=>{finish=r;}));
    const stop=createBusinessDeletionProcessor(work,1000);
    await vi.advanceTimersByTimeAsync(3000);expect(work).toHaveBeenCalledTimes(1);
    stop();finish();await vi.advanceTimersByTimeAsync(3000);expect(work).toHaveBeenCalledTimes(1);
  });
  it.each(["development","test"])("does not start jobs in %s",env=>{
    vi.stubEnv("NODE_ENV",env);startBusinessDeletionProcessor();expect(mocks.work).not.toHaveBeenCalled();
  });
  it.each(["build","sync-worker"])("does not start jobs in the %s process",kind=>{
    vi.stubEnv("NODE_ENV","production");vi.stubEnv(kind==="build"?"NEXT_PHASE":"SYNC_WORKER_MODE",kind==="build"?"phase-production-build":"1");
    startBusinessDeletionProcessor();expect(mocks.work).not.toHaveBeenCalled();
  });
});
