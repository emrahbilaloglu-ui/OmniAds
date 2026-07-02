import { getDb } from "@/lib/db";

export type BusinessGuardFailureReason =
  | "invalid_business_id"
  | "business_not_found";

export interface BusinessGuardFailure {
  reason: BusinessGuardFailureReason;
  message: string;
  errorJson: {
    name: BusinessGuardFailureReason;
    businessId: string;
  };
}

type BusinessExistsRow = Record<string, unknown> & {
  exists: unknown;
};

function isUuidLike(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export async function getBusinessGuardFailure(
  businessId: string,
): Promise<BusinessGuardFailure | null> {
  if (!isUuidLike(businessId)) {
    return {
      reason: "invalid_business_id",
      message: `Invalid business id: ${businessId}`,
      errorJson: { name: "invalid_business_id", businessId },
    };
  }

  const [row] = await getDb().query<BusinessExistsRow>(
    `
    SELECT EXISTS (
      SELECT 1
      FROM businesses
      WHERE id = $1::uuid
    ) AS exists
    `,
    [businessId],
  );
  if (row?.exists === true) return null;

  return {
    reason: "business_not_found",
    message: `Business not found: ${businessId}`,
    errorJson: { name: "business_not_found", businessId },
  };
}
