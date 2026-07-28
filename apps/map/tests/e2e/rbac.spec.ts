import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * Blocking-tier RBAC E2E suite for the map update-request flow.
 *
 * Implements the RBAC-critical paths from
 * specs/map-update-request-flow.md §5 (RBAC table) + §8 (blocking tier)
 * via direct API calls — no browser, fully deterministic:
 *
 *   1. Non-editor submit → recorded `pending`            (§8.2, AC-8)
 *   2. Editor submit → auto-applied (`approved`)          (§8.3, AC-9)
 *   3. Non-editor reject is denied, request stays pending (§5 reject row)
 *   4. Cross-region editor reject is denied, request stays
 *      pending (§8.6, AC-15) — plus the positive control: the same
 *      region-scoped editor CAN reject inside its own region
 *   5. Unauthenticated submit is denied                   (§5 row 2)
 *
 * HOW PROCEDURES ARE INVOKED: the api app serves every oRPC procedure that
 * declares a `.route()` through its OpenAPI handler (apps/api/src/app/
 * [[...rest]]/route.ts). Requests whose `client` header is NOT an oRPC
 * client value ("orpc" / "orpc-ssg" / "f3-me") are dispatched by route path,
 * so plain REST calls work: POST {E2E_API_URL}/v1/request/update-request,
 * POST /v1/request/reject-submission, GET /v1/request/id/{id}, etc.
 * (router prefixes: packages/api/src/index.ts → os.prefix("/v1"),
 * os.prefix("/request")).
 *
 * AUTH: recipe 1 of docs/PREVIEW_AUTH.md — seeded API keys as bearer tokens
 * plus the `client` header (required for API-key auth by getSession in
 * packages/api/src/shared.ts):
 *
 *   - local-slackbot-key     → admin, scoped to the F3 Nation org
 *   - local-api-key          → editor, scoped to the F3 Nation org
 *   - local-boone-editor-key → editor, scoped to the BOONE REGION org only
 *   - local-map-key          → NO role (read-only tier is the absence of a role)
 *
 * SEED SCOPING: checkHasRoleOnOrg accepts a role on any ancestor org, so the
 * nation-scoped principals can edit BOTH seeded regions (Boone and
 * F3 Charlotte). local-boone-editor-key is the region-scoped principal
 * (packages/db/src/local-seed-lib/users.ts attaches its editor role to the
 * Boone region org, not the nation), which makes AC-15's precise case — an
 * editor of region S rejecting in region R — deterministically testable:
 * Boone is not an ancestor of F3 Charlotte, so rejectSubmission's
 * checkHasRoleOnOrg denies with UNAUTHORIZED ("You are not authorized to
 * edit this region", packages/api/src/router/request.ts) even though the
 * key clears the editorProcedure gate (editor on SOME org).
 *
 * DATA ASSUMPTION: E2E_API_URL is a preview api backed by the deterministic
 * sandbox seed (packages/db/src/local-seed-lib/data.ts): regions "Boone" and
 * "F3 Charlotte", Boone AO "The Dark Tower", Charlotte AO "The Colosseum",
 * event type "Bootcamp". Region/AO/event-type ids are resolved at runtime
 * through the routed org and event-type endpoints rather than hardcoded.
 * The preview DB persists for the duration of a run (resets on cold start),
 * so every test submits uniquely-named events/AOs — reruns never collide
 * and no cleanup is needed. New events are created at 05:30 AM to preserve
 * the AM/PM determinism browse.spec.ts relies on.
 */

const API_KEYS = {
  admin: "local-slackbot-key",
  editor: "local-api-key",
  booneEditor: "local-boone-editor-key",
  noRole: "local-map-key",
} as const;

// Required at run time, but do NOT throw at module load: a module-scope throw
// aborts Playwright's collection of every other spec. The value is asserted in
// beforeAll below, so a missing var fails only this file.
const API_URL = (process.env.E2E_API_URL ?? "").replace(/\/$/, "");

// Cold-starting scale-to-zero preview: first request may wait out a boot.
const REQUEST_TIMEOUT_MS = 60_000;

interface OrgsResponse {
  orgs: { id: number; name: string; orgType: string }[];
  total: number;
}

interface EventTypesResponse {
  eventTypes: { id: number; name: string }[];
}

interface SubmitResponse {
  status: string;
  updateRequest?: { id?: string; status?: string; regionId?: number };
}

interface RequestByIdResponse {
  request: { id: string; status: string } | null;
}

interface OrpcErrorBody {
  code?: string;
  status?: number;
  message?: string;
}

function headersFor(apiKey: string | null): Record<string, string> {
  return {
    // Any non-oRPC value routes to the OpenAPI handler AND satisfies the
    // `client`-header requirement of API-key auth (packages/api/src/shared.ts).
    client: "e2e",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function getJson<T>(
  request: APIRequestContext,
  path: string,
  apiKey: string,
  params?: Record<string, string>,
): Promise<T> {
  const res = await request.get(`${API_URL}${path}`, {
    headers: headersFor(apiKey),
    params,
    timeout: REQUEST_TIMEOUT_MS,
  });
  expect(res.status(), `GET ${path} should succeed`).toBe(200);
  return (await res.json()) as T;
}

async function resolveOrgId(
  request: APIRequestContext,
  apiKey: string,
  orgType: "region" | "ao",
  name: string,
): Promise<number> {
  const body = await getJson<OrgsResponse>(request, "/v1/org/", apiKey, {
    orgTypes: orgType,
    searchTerm: name,
  });
  const org = body.orgs.find((o) => o.name === name);
  expect(org, `seeded ${orgType} "${name}" should exist`).toBeTruthy();
  return org!.id;
}

async function resolveBootcampTypeId(
  request: APIRequestContext,
  apiKey: string,
): Promise<number> {
  const body = await getJson<EventTypesResponse>(
    request,
    "/v1/event-type/",
    apiKey,
    { searchTerm: "Bootcamp" },
  );
  const bootcamp = body.eventTypes.find((et) => et.name === "Bootcamp");
  expect(bootcamp, 'seeded event type "Bootcamp" should exist').toBeTruthy();
  return bootcamp!.id;
}

/** Unique per submission so reruns against a warm preview never collide. */
function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A valid `create_event` payload for POST /v1/request/update-request
 * (RequestInsertSchema). With no eventId/locationId/aoId the apply path
 * creates a fresh location + AO + event, leaving seeded data untouched.
 */
function createEventPayload(options: {
  regionId: number;
  eventTypeId: number;
  suffix: string;
  aoId?: number;
  aoName?: string;
}) {
  const { regionId, eventTypeId, suffix, aoId, aoName } = options;
  return {
    id: crypto.randomUUID(),
    requestType: "create_event",
    regionId,
    eventTypeIds: [eventTypeId],
    eventName: `E2E RBAC Bootcamp ${suffix}`,
    eventDescription: "Created by the RBAC blocking-tier E2E suite",
    eventDayOfWeek: "monday",
    // 05:30 AM keeps the browse suite's AM/PM filter determinism intact.
    eventStartTime: "0530",
    eventEndTime: "0615",
    eventRecurrencePattern: "weekly",
    eventRecurrenceInterval: 1,
    ...(aoId !== undefined ? { aoId } : {}),
    aoName: aoName ?? `E2E RBAC AO ${suffix}`,
    locationName: `E2E RBAC Location ${suffix}`,
    locationAddress: "123 E2E Test Street",
    locationCity: "Boone",
    locationState: "NC",
    locationCountry: "US",
    locationLat: 36.2168,
    locationLng: -81.6746,
    submittedBy: "e2e-rbac@f3local.dev",
  };
}

async function submitUpdateRequest(
  request: APIRequestContext,
  apiKey: string | null,
  payload: ReturnType<typeof createEventPayload>,
) {
  return request.post(`${API_URL}/v1/request/update-request`, {
    headers: headersFor(apiKey),
    data: payload,
    timeout: REQUEST_TIMEOUT_MS,
  });
}

/**
 * Arrange helper: submit a valid create_event request with the no-role key
 * against a seeded region + AO. Non-editor submissions are never auto-applied,
 * so this deterministically yields a `pending` request; returns its id.
 */
async function submitPendingRequest(
  request: APIRequestContext,
  regionName: string,
  aoName: string,
): Promise<string> {
  const key = API_KEYS.noRole;
  const regionId = await resolveOrgId(request, key, "region", regionName);
  const aoId = await resolveOrgId(request, key, "ao", aoName);
  const eventTypeId = await resolveBootcampTypeId(request, key);

  const submitRes = await submitUpdateRequest(
    request,
    key,
    createEventPayload({
      regionId,
      eventTypeId,
      suffix: uniqueSuffix(),
      aoId,
      aoName,
    }),
  );
  expect(submitRes.status()).toBe(200);
  const submitted = (await submitRes.json()) as SubmitResponse;
  expect(submitted.status).toBe("pending");
  const requestId = submitted.updateRequest?.id;
  expect(requestId).toBeTruthy();
  return requestId!;
}

function rejectSubmission(
  request: APIRequestContext,
  apiKey: string,
  requestId: string,
) {
  return request.post(`${API_URL}/v1/request/reject-submission`, {
    headers: headersFor(apiKey),
    data: { id: requestId },
    timeout: REQUEST_TIMEOUT_MS,
  });
}

test.describe("update-request RBAC (direct api)", () => {
  test.beforeAll(() => {
    if (!API_URL) {
      throw new Error(
        "E2E_API_URL is required but not set. Point it at the api deployment " +
          "under test, e.g. " +
          "E2E_API_URL=https://pr-123-api-<project>.us-central1.run.app " +
          "pnpm test:e2e",
      );
    }
  });

  test("non-editor submit is recorded as a pending request (AC-8)", async ({
    request,
  }) => {
    const key = API_KEYS.noRole;
    const regionId = await resolveOrgId(request, key, "region", "Boone");
    const aoId = await resolveOrgId(request, key, "ao", "The Dark Tower");
    const eventTypeId = await resolveBootcampTypeId(request, key);

    // A no-role key targeting a seeded Boone AO: valid submission, but the
    // submitter is not an editor of the affected region → pending.
    const res = await submitUpdateRequest(
      request,
      key,
      createEventPayload({
        regionId,
        eventTypeId,
        suffix: uniqueSuffix(),
        aoId,
        aoName: "The Dark Tower",
      }),
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as SubmitResponse;
    expect(body.status).toBe("pending");
    expect(body.updateRequest?.id).toBeTruthy();
    expect(body.updateRequest?.status).toBe("pending");
  });

  test("editor submit is auto-applied (AC-9)", async ({ request }) => {
    const key = API_KEYS.editor;
    const regionId = await resolveOrgId(request, key, "region", "Boone");
    const eventTypeId = await resolveBootcampTypeId(request, key);

    // local-api-key holds editor on the Nation org — an ancestor of every
    // seeded region — so checkHasRoleOnOrg passes for Boone and the change
    // applies immediately (a new location + AO + event, uniquely named).
    const res = await submitUpdateRequest(
      request,
      key,
      createEventPayload({ regionId, eventTypeId, suffix: uniqueSuffix() }),
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as SubmitResponse;
    expect(body.status).toBe("approved");
    expect(body.updateRequest?.status).toBe("approved");
  });

  test("non-editor cannot reject; request stays pending (§5 reject row)", async ({
    request,
  }) => {
    // Arrange: a pending request in F3 Charlotte, submitted by the no-role key.
    const requestId = await submitPendingRequest(
      request,
      "F3 Charlotte",
      "The Colosseum",
    );

    // Act: the same no-role key — a principal with editor on NO org — is
    // stopped at the editorProcedure gate before any per-region check.
    const rejectRes = await rejectSubmission(
      request,
      API_KEYS.noRole,
      requestId,
    );
    expect(rejectRes.status()).toBe(401);
    const rejectBody = (await rejectRes.json()) as OrpcErrorBody;
    expect(rejectBody.code).toBe("UNAUTHORIZED");

    // Assert: the request is still pending (checked with the admin key,
    // whose nation-scoped admin role satisfies editorProcedure).
    const byId = await getJson<RequestByIdResponse>(
      request,
      `/v1/request/id/${requestId}`,
      API_KEYS.admin,
    );
    expect(byId.request?.status).toBe("pending");
  });

  test("editor of another region cannot reject; request stays pending (AC-15)", async ({
    request,
  }) => {
    // Arrange: a pending request in F3 Charlotte (region R).
    const requestId = await submitPendingRequest(
      request,
      "F3 Charlotte",
      "The Colosseum",
    );

    // Act: the Boone-scoped editor (region S) attempts the reject. It clears
    // the editorProcedure gate (editor on SOME org) but Boone is not an
    // ancestor of F3 Charlotte, so rejectSubmission's checkHasRoleOnOrg
    // denies with the region-specific UNAUTHORIZED.
    const rejectRes = await rejectSubmission(
      request,
      API_KEYS.booneEditor,
      requestId,
    );
    expect(rejectRes.status()).toBe(401);
    const rejectBody = (await rejectRes.json()) as OrpcErrorBody;
    expect(rejectBody.code).toBe("UNAUTHORIZED");
    // Substring, not exact-match: assert it identifies the region-authorization
    // failure without pinning the test to the exact copy.
    expect(rejectBody.message).toMatch(/not authorized.*region/i);

    // Assert: the request is still pending.
    const byId = await getJson<RequestByIdResponse>(
      request,
      `/v1/request/id/${requestId}`,
      API_KEYS.admin,
    );
    expect(byId.request?.status).toBe("pending");
  });

  test("region-scoped editor CAN reject inside its own region (AC-15 positive control)", async ({
    request,
  }) => {
    // Arrange: a pending request in Boone — the region the key is scoped to.
    const requestId = await submitPendingRequest(
      request,
      "Boone",
      "The Dark Tower",
    );

    // Act: the Boone-scoped editor rejects a Boone-region request. This
    // proves the AC-15 denial above is region scoping, not a broken key.
    const rejectRes = await rejectSubmission(
      request,
      API_KEYS.booneEditor,
      requestId,
    );
    expect(rejectRes.status()).toBe(200);
    const rejectBody = (await rejectRes.json()) as { status?: string };
    expect(rejectBody.status).toBe("rejected");

    // Assert: the request is persisted as rejected.
    const byId = await getJson<RequestByIdResponse>(
      request,
      `/v1/request/id/${requestId}`,
      API_KEYS.admin,
    );
    expect(byId.request?.status).toBe("rejected");
  });

  test("unauthenticated submit is denied (§5 row 2)", async ({ request }) => {
    // A structurally valid payload with NO bearer token. regionId 0 never
    // exists, but protectedProcedure rejects before any handler logic runs.
    const res = await submitUpdateRequest(
      request,
      null,
      createEventPayload({
        regionId: 0,
        eventTypeId: 1,
        suffix: uniqueSuffix(),
      }),
    );
    expect(res.status()).toBe(401);
    const body = (await res.json()) as OrpcErrorBody;
    expect(body.code).toBe("UNAUTHORIZED");
  });
});
