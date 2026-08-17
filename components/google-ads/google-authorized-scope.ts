/**
 * Immutable scope resolved by an authenticated `/c/[businessId]` server route.
 *
 * Presence is authoritative even when `providerAccountId` is null: null means
 * the server could not choose one account without guessing (for example, a
 * multi-account portfolio with no explicit URL selection). Client stores and
 * account pickers must never widen or replace this scope.
 */
export interface GoogleAuthorizedScope {
  businessId: string;
  businessName: string | null;
  providerAccountId: string | null;
  accountLabel: string | null;
  currency: string | null;
  timezone: string | null;
  viewerReadOnly: boolean;
  demo: boolean;
}
