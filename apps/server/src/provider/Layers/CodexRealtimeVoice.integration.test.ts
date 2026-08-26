// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import {
  CodexSessionRuntimeRealtimeVoiceAnswerTimeoutError,
  CodexSessionRuntimeRealtimeVoiceNegotiationError,
  CodexSessionRuntimeRealtimeVoiceStoppedError,
  CodexSessionRuntimeRealtimeVoiceStopTimeoutError,
  makeCodexSessionRuntime,
  type CodexSessionRuntimeError,
} from "./CodexSessionRuntime.ts";

const peerPath = NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh");

function runtimeTest(
  name: string,
  script: Record<string, unknown>,
  run: (
    runtime: Effect.Success<ReturnType<typeof makeCodexSessionRuntime>>,
    scriptPath: string,
  ) => Effect.Effect<void, CodexSessionRuntimeError, Scope.Scope>,
) {
  it.live(name, () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-voice-"));
      const scriptPath = NodePath.join(directory, "script.json");
      NodeFS.writeFileSync(
        scriptPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({ rootThreadId: wireFixture.rootThreadId, notifications: [], ...script }),
        "utf8",
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(directory, { force: true, recursive: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make(`thread-${name}`),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        realtimeVoiceNegotiationTimeoutMs: 500,
        realtimeVoiceStopTimeoutMs: 200,
      });
      yield* Effect.addFinalizer(() => runtime.close);
      yield* runtime.start();
      yield* run(runtime, scriptPath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

describe("CodexSessionRuntime realtime voice", () => {
  runtimeTest(
    "stops an in-flight negotiation and permits an immediate restart",
    {
      realtimeStarts: [{ started: true }, { sdp: "answer-sdp" }],
      realtimeStopSdp: "stale-answer-sdp",
    },
    (runtime, scriptPath) =>
      Effect.gen(function* () {
        const started = yield* runtime.events.pipe(
          Stream.filter((event) => event.method === "thread/realtime/started"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const firstStart = yield* runtime.startRealtimeVoice("first-offer").pipe(Effect.forkScoped);
        yield* Fiber.join(started);

        yield* runtime.stopRealtimeVoice;
        const stoppedExit = yield* Fiber.await(firstStart);
        assert.isTrue(Exit.isFailure(stoppedExit));
        if (Exit.isFailure(stoppedExit)) {
          assert.instanceOf(
            Cause.squash(stoppedExit.cause),
            CodexSessionRuntimeRealtimeVoiceStoppedError,
          );
        }
        const stops = NodeFS.readFileSync(`${scriptPath}.realtime-stops`, "utf8");
        assert.lengthOf(stops.trim().split("\n"), 1);

        const answer = yield* runtime.startRealtimeVoice("second-offer");
        assert.equal(answer, "answer-sdp");
      }),
  );

  runtimeTest(
    "stops the provider when an in-flight start is interrupted",
    { realtimeStarts: [{ hangRequest: true, started: true }] },
    (runtime, scriptPath) =>
      Effect.gen(function* () {
        const started = yield* runtime.events.pipe(
          Stream.filter((event) => event.method === "thread/realtime/started"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const start = yield* runtime.startRealtimeVoice("offer-sdp").pipe(Effect.forkScoped);
        yield* Fiber.join(started);

        yield* Fiber.interrupt(start);

        const stops = NodeFS.readFileSync(`${scriptPath}.realtime-stops`, "utf8");
        assert.include(stops, wireFixture.rootThreadId);
      }),
  );

  runtimeTest(
    "does not start a retry while the prior stop is unresolved",
    {
      realtimeStarts: [{ started: true }, { sdp: "recovered-answer" }],
      realtimeStops: [{ hangRequest: true, started: true }, {}],
    },
    (runtime, scriptPath) =>
      Effect.gen(function* () {
        const started = yield* runtime.events.pipe(
          Stream.filter((event) => event.method === "thread/realtime/started"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* runtime.startRealtimeVoice("first-offer").pipe(Effect.forkScoped);
        yield* Fiber.join(started);

        const stopObserved = yield* runtime.events.pipe(
          Stream.filter((event) => event.method === "thread/realtime/started"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* runtime.stopRealtimeVoice.pipe(Effect.forkScoped);
        yield* Fiber.join(stopObserved);
        const retry = yield* Effect.exit(runtime.startRealtimeVoice("retry-offer"));

        assert.isTrue(Exit.isFailure(retry));
        if (Exit.isFailure(retry)) {
          assert.instanceOf(
            Cause.squash(retry.cause),
            CodexSessionRuntimeRealtimeVoiceStopTimeoutError,
          );
        }
        const starts = NodeFS.readFileSync(`${scriptPath}.realtime-starts`, "utf8");
        assert.lengthOf(starts.trim().split("\n"), 1);

        const answer = yield* runtime.startRealtimeVoice("recovered-offer");
        assert.equal(answer, "recovered-answer");
      }),
  );

  runtimeTest(
    "recovers when the caller interrupts an in-flight stop",
    {
      realtimeStarts: [{ sdp: "first-answer" }, { sdp: "recovered-answer" }],
      realtimeStops: [{ hangRequest: true, started: true }, {}],
    },
    (runtime, scriptPath) =>
      Effect.gen(function* () {
        yield* runtime.startRealtimeVoice("first-offer");
        const stopObserved = yield* runtime.events.pipe(
          Stream.filter((event) => event.method === "thread/realtime/started"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const stop = yield* runtime.stopRealtimeVoice.pipe(Effect.forkScoped);
        yield* Fiber.join(stopObserved);

        yield* Fiber.interrupt(stop);

        const answer = yield* runtime.startRealtimeVoice("recovered-offer");
        assert.equal(answer, "recovered-answer");
        const stops = NodeFS.readFileSync(`${scriptPath}.realtime-stops`, "utf8");
        assert.lengthOf(stops.trim().split("\n"), 2);
      }),
  );

  runtimeTest(
    "allows a retry after a definitive stop error response",
    {
      realtimeStarts: [{ started: true }, { sdp: "retry-answer" }],
      realtimeStops: [{ error: "no live realtime session" }],
    },
    (runtime) =>
      Effect.gen(function* () {
        const started = yield* runtime.events.pipe(
          Stream.filter((event) => event.method === "thread/realtime/started"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const firstStart = yield* runtime.startRealtimeVoice("first-offer").pipe(Effect.forkScoped);
        yield* Fiber.join(started);

        const stop = yield* Effect.exit(runtime.stopRealtimeVoice);
        assert.isTrue(Exit.isFailure(stop));
        yield* Fiber.await(firstStart);

        const answer = yield* runtime.startRealtimeVoice("retry-offer");
        assert.equal(answer, "retry-answer");
      }),
  );

  runtimeTest(
    "does not start realtime voice after the runtime closes",
    { realtimeStarts: [{ sdp: "must-not-start" }] },
    (runtime, scriptPath) =>
      Effect.gen(function* () {
        yield* runtime.close;

        const exit = yield* Effect.exit(runtime.startRealtimeVoice("offer-sdp"));

        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.instanceOf(Cause.squash(exit.cause), CodexSessionRuntimeRealtimeVoiceStoppedError);
        }
        assert.isFalse(NodeFS.existsSync(`${scriptPath}.realtime-starts`));
      }),
  );

  runtimeTest(
    "fails immediately when Codex rejects negotiation",
    { realtimeStarts: [{ error: "mock negotiation rejected" }] },
    (runtime) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(runtime.startRealtimeVoice("offer-sdp"));
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          assert.instanceOf(error, CodexSessionRuntimeRealtimeVoiceNegotiationError);
          assert.include((error as Error).message, "mock negotiation rejected");
        }
      }),
  );

  runtimeTest(
    "times out a hung start request and clears the negotiation slot",
    { realtimeStarts: [{ hangRequest: true }, { sdp: "retry-answer-sdp" }] },
    (runtime) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(runtime.startRealtimeVoice("hung-offer"));
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.instanceOf(
            Cause.squash(exit.cause),
            CodexSessionRuntimeRealtimeVoiceAnswerTimeoutError,
          );
        }

        const answer = yield* runtime.startRealtimeVoice("retry-offer");
        assert.equal(answer, "retry-answer-sdp");
      }),
  );

  runtimeTest(
    "bounds realtime cleanup when the stop request hangs",
    { realtimeStarts: [{ sdp: "answer-sdp" }], hangRealtimeStop: true },
    (runtime) =>
      Effect.gen(function* () {
        yield* runtime.startRealtimeVoice("offer-sdp");
        yield* runtime.close;
      }),
  );

  runtimeTest(
    "closes a pending start even when the stop request hangs",
    { realtimeStarts: [{ hangRequest: true, started: true }], hangRealtimeStop: true },
    (runtime) =>
      Effect.gen(function* () {
        const started = yield* runtime.events.pipe(
          Stream.filter((event) => event.method === "thread/realtime/started"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const start = yield* runtime.startRealtimeVoice("offer-sdp").pipe(Effect.forkScoped);
        yield* Fiber.join(started);

        yield* runtime.close;

        const exit = yield* Fiber.await(start);
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.instanceOf(Cause.squash(exit.cause), CodexSessionRuntimeRealtimeVoiceStoppedError);
        }
      }),
  );
});
