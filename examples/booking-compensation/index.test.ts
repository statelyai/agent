/**
 * The runner defaults to real OpenAI executors. These tests script the planner
 * at the provider with the repo's AI SDK mock, answering by request name
 * (`plan`); booking actors are overridden through native XState `actors`.
 */
import { expect, test } from "vitest";
import { createAsyncLogic } from "xstate";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import { bookingCompensationMachine, runBookingCompensationExample } from "./index.js";

// One shared mock: the `plan` answer repeats for every run.
const executors = createMockModelExecutors({
  text: { plan: { flight: "Flight to Lisbon", hotel: "Lisbon hotel" } },
});

test("approval gates reservations and a confirmed unavailable hotel compensates the flight", async () => {
  const calls: string[] = [];
  const actors = {
    reserveFlight: createAsyncLogic<string, { bookingId: string; item: string }>({
      run: async ({ input }) => {
        calls.push(`flight:${input.bookingId}`);
        return "flight-42";
      },
    }),
    reserveHotel: createAsyncLogic<{ status: "unavailable" }, { bookingId: string; item: string }>({
      run: async () => {
        calls.push("hotel");
        return { status: "unavailable" };
      },
    }),
    cancelFlight: createAsyncLogic<
      { status: "cancelled" },
      { bookingId: string; reference: string }
    >({
      run: async ({ input }) => {
        calls.push(`cancel:${input.reference}`);
        return { status: "cancelled" as const };
      },
    }),
  };
  const pending = await runBookingCompensationExample({ actors, executors });
  expect(pending.status).toBe("idle");
  expect(calls).toEqual([]);
  const result = await runBookingCompensationExample({
    snapshot: JSON.parse(JSON.stringify(pending.persist())),
    event: { type: "APPROVE" },
    actors,
    executors,
  });
  expect(calls).toEqual(["flight:trip-1", "hotel", "cancel:flight-42"]);
  expect(result.status).toBe("done");
  if (result.status === "done")
    expect(result.output).toMatchObject({
      outcome: "compensated",
      flightReference: "flight-42",
      hotelReference: null,
    });
});

test("failed compensation preserves the reservation reference for manual recovery", async () => {
  const pending = await runBookingCompensationExample({ executors });
  const result = await runBookingCompensationExample({
    snapshot: pending.persist(),
    event: { type: "APPROVE" },
    executors,
    actors: {
      reserveHotel: createAsyncLogic<
        { status: "unavailable" },
        { bookingId: string; item: string }
      >({ run: async () => ({ status: "unavailable" }) }),
      cancelFlight: createAsyncLogic<
        { status: "cancelled" },
        { bookingId: string; reference: string }
      >({
        run: async () => {
          throw new Error("Cancellation unavailable");
        },
      }),
    },
  });
  expect(result.status).toBe("done");
  if (result.status === "done")
    expect(result.output).toMatchObject({
      outcome: "manualRecovery",
      flightReference: "simulated-flight:trip-1",
    });
});

test("uncertain hotel outcome requires reconciliation, not blind compensation", async () => {
  let compensations = 0;
  const pending = await runBookingCompensationExample({ executors });
  const result = await runBookingCompensationExample({
    snapshot: pending.persist(),
    event: { type: "APPROVE" },
    executors,
    actors: {
      reserveHotel: createAsyncLogic<
        { status: "unavailable" },
        { bookingId: string; item: string }
      >({
        run: async () => {
          throw new Error("Reply lost; booking may exist");
        },
      }),
      cancelFlight: createAsyncLogic<
        { status: "cancelled" },
        { bookingId: string; reference: string }
      >({
        run: async () => {
          compensations++;
          return { status: "cancelled" as const };
        },
      }),
    },
  });
  expect(compensations).toBe(0);
  expect(result.status).toBe("done");
  if (result.status === "done") expect(result.output.outcome).toBe("manualRecovery");
});

test.each(["APPROVE", "CANCEL"] as const)(
  "%s completes the happy or cancellation path",
  async (type) => {
    const pending = await runBookingCompensationExample({ executors });
    const result = await runBookingCompensationExample({
      snapshot: pending.persist(),
      event: { type },
      executors,
    });
    expect(result.status).toBe("done");
    if (result.status === "done")
      expect(result.output.outcome).toBe(type === "APPROVE" ? "booked" : "cancelled");
    expect(
      lintAgentMachine(bookingCompensationMachine).filter((d) => d.severity === "error"),
    ).toEqual([]);
  },
);

test("uncertain flight outcome retains the booking identity even without provider references", async () => {
  const pending = await runBookingCompensationExample({ executors });
  const result = await runBookingCompensationExample({
    snapshot: pending.persist(),
    event: { type: "APPROVE" },
    executors,
    actors: {
      reserveFlight: createAsyncLogic<string, { bookingId: string; item: string }>({
        run: async () => {
          throw new Error("Reply lost");
        },
      }),
    },
  });
  expect(result.status).toBe("done");
  if (result.status === "done")
    expect(result.output).toEqual({
      bookingId: "trip-1",
      outcome: "manualRecovery",
      flightReference: null,
      hotelReference: null,
      itinerary: "Flight: Flight to Lisbon\n\nHotel: Lisbon hotel",
    });
});

test("a hotel reservation without a provider reference is not a booking", async () => {
  const pending = await runBookingCompensationExample({ executors });
  const result = await runBookingCompensationExample({
    snapshot: pending.persist(),
    event: { type: "APPROVE" },
    executors,
    actors: {
      reserveHotel: createAsyncLogic<
        { status: "reserved"; reference: string },
        { bookingId: string; item: string }
      >({
        // A provider that reports success but returns no reference.
        run: async () => ({ status: "reserved" }) as { status: "reserved"; reference: string },
      }),
    },
  });
  expect(result.status).toBe("done");
  if (result.status === "done")
    expect(result.output).toMatchObject({ outcome: "manualRecovery", hotelReference: null });
});

test("an unconfirmed cancellation is reported as manual recovery, not compensated", async () => {
  const pending = await runBookingCompensationExample({ executors });
  const result = await runBookingCompensationExample({
    snapshot: pending.persist(),
    event: { type: "APPROVE" },
    executors,
    actors: {
      reserveHotel: createAsyncLogic<
        { status: "unavailable" },
        { bookingId: string; item: string }
      >({ run: async () => ({ status: "unavailable" }) }),
      cancelFlight: createAsyncLogic<
        { status: "pending" },
        { bookingId: string; reference: string }
      >({ run: async () => ({ status: "pending" }) }),
    },
  });
  expect(result.status).toBe("done");
  if (result.status === "done")
    expect(result.output).toMatchObject({
      outcome: "manualRecovery",
      flightReference: "simulated-flight:trip-1",
    });
});

test("the plan prompt asks for a plain plan, without booking disclaimers", async () => {
  const scripted = createMockModelExecutors({
    text: { plan: { flight: "Flight to Lisbon", hotel: "Lisbon hotel" } },
  });
  await runBookingCompensationExample({ executors: scripted });
  const request = scripted.calls.find((call) => call.name === "plan")!.request;
  const text = `${request.system ?? ""}\n${request.prompt ?? ""}`;
  // "Do not book anything" made the model echo "…but I'm not booking anything".
  expect(text).not.toMatch(/do not book/i);
  expect(request.system).toContain("never add disclaimers about booking");
  expect(request.prompt).toBe("Destination: Lisbon");
});

test("the output's itinerary is readable text, not an object", async () => {
  const pending = await runBookingCompensationExample({ executors });
  expect(pending.status).toBe("idle");
  if (pending.status !== "idle") return;
  const result = await runBookingCompensationExample({
    snapshot: pending.persist(),
    event: { type: "APPROVE" },
    executors,
  });
  expect(result.status).toBe("done");
  if (result.status === "done")
    expect(result.output.itinerary).toBe("Flight: Flight to Lisbon\n\nHotel: Lisbon hotel");
});

test("without injected executors or a key, the runner rejects naming the env var", async () => {
  const key = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await expect(runBookingCompensationExample()).rejects.toThrow("OPENAI_API_KEY");
  } finally {
    if (key !== undefined) process.env.OPENAI_API_KEY = key;
  }
});
