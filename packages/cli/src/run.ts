import path from "node:path";
import type { Command } from "commander";
import { openVoyage, promptAndWait, type EventObserver, type RawEventObserver } from "@botiverse/oar";
import { exitWhenFinished } from "./exit.js";
import { createProgressRenderer, renderOpened } from "./progress.js";
import { runtimes } from "./runtimes.js";

const jsonObserver: RawEventObserver = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

function progressObserver(runtimeId: string): EventObserver {
  const render = createProgressRenderer(runtimeId);
  return (event) => {
    for (const line of render(event)) {
      process.stdout.write(`${line}\n`);
    }
  };
}

/** `oar run`: one turn in a fresh (or resumed) session, its progress shown live. */
export function registerRunCommand(program: Command, version: string): void {
  program
    .command("run <runtime> <prompt>")
    .description("Run one turn in a fresh (or --resume'd) session and show its progress")
    .option("--model <model>", "runtime-native model identifier")
    .option("--effort <level>", "runtime-native reasoning-effort level (one of the model's effort levels in `oar models`)")
    .option("--service-tier <tier>", "runtime-native service tier (see `oar models`), or default to disable")
    .option("--resume <sessionId>", "resume the runtime-native session a previous run printed")
    .option("--json", "print the session records as JSON lines instead of progress")
    .option("--record <file>", "write the run as an oar-voyage/3 JSONL log")
    .option("--image <file...>", "send image files with the prompt (png, jpeg, gif, webp), as the runtime's own image input")
    .action(async (
      id: string,
      prompt: string,
      flags: { model?: string; effort?: string; serviceTier?: string; resume?: string; json?: boolean; record?: string; image?: string[] },
    ) => {
      const runtime = runtimes.require(id);
      if (runtime.installation === undefined) {
        process.stderr.write(`${id} has no installation capability\n`);
        process.exitCode = 1;
        return;
      }
      const installation = await runtime.installation();
      if (installation.kind !== "available") {
        process.stderr.write(`${id} is not available: ${installation.kind}\n`);
        process.exitCode = 1;
        return;
      }
      // A refused open (an effort the runtime would not run, a resume id it
      // does not know) is the runtime's answer, not a crash.
      const session = await runtime.session(installation, {
        cwd: process.cwd(),
        ...(flags.model === undefined ? {} : { model: flags.model }),
        ...(flags.effort === undefined ? {} : { effort: flags.effort }),
        ...(flags.serviceTier === undefined ? {} : { serviceTier: flags.serviceTier }),
        ...(flags.resume === undefined ? {} : { resume: flags.resume }),
      }).catch((error: unknown) => {
        process.stderr.write(`${id} session did not open: ${error instanceof Error ? error.message : String(error)}\n`);
        return null;
      });
      if (session === null) {
        process.exitCode = 1;
        return;
      }
      const recorder = flags.record === undefined
        ? undefined
        : openVoyage(flags.record, {
            runtime: id,
            ...(flags.model === undefined ? {} : { model: flags.model }),
            ...(flags.effort === undefined ? {} : { effort: flags.effort }),
            ...(flags.serviceTier === undefined ? {} : { serviceTier: flags.serviceTier }),
            cwd: process.cwd(),
            sessionId: session.id,
            startedAt: Date.now(),
            recorder: `oar-cli/${version}`,
          });
      // Replay from the start so the log and the output carry the records the
      // adapter stamped while opening (model, handshake frames), not only what
      // arrives after this subscription.
      const cursor = { sessionId: session.id, afterSeq: -1 };
      session.rawEvents((record) => {
        recorder?.record(record);
        if (flags.json === true) {
          jsonObserver(record);
        }
      }, cursor);
      if (flags.json !== true) {
        process.stdout.write(`${renderOpened({
          sessionId: session.id,
          resumed: flags.resume !== undefined,
          model: session.model().value,
          effort: session.effort().value,
          serviceTier: session.serviceTier().value,
        })}\n`);
        session.events(progressObserver(id), { cursor, coalesceText: { maxHoldMs: 250 } });
      }
      // The runtime leads its own process group, so the terminal's Ctrl-C
      // reaches this process only. The first one interrupts the turn (the
      // session is then disposed as usual), a later one disposes at once; the
      // handler stays until the dispose settles, so the runtime and everything
      // it started are always taken down with the run.
      const interrupt = new AbortController();
      // A repeated dispose() returns at once; the run waits for the first one.
      let disposal: Promise<void> | null = null;
      const dispose = async (): Promise<void> => {
        disposal ??= session.dispose();
        await disposal;
      };
      const onInterrupt = (): void => {
        if (interrupt.signal.aborted) {
          void dispose();
        } else {
          interrupt.abort();
        }
      };
      process.on("SIGINT", onInterrupt);
      const images = flags.image?.map((file) => ({ path: path.resolve(file) }));
      const run = await promptAndWait(session, prompt, { signal: interrupt.signal, ...(images === undefined ? {} : { images }) });
      await dispose();
      process.off("SIGINT", onInterrupt);
      recorder?.end("disposed");
      exitWhenFinished();
      if (run.kind === "rejected") {
        process.stderr.write(`prompt not accepted (${run.code}): ${run.reason}\n`);
        process.exitCode = 1;
        return;
      }
      const { outcome } = run;
      if (flags.json === true) {
        process.stdout.write(`${JSON.stringify({ outcome })}\n`);
      }
      if (run.kind === "interrupted" && run.by === "signal") {
        process.exitCode = 130;
        return;
      }
      process.exitCode = outcome.kind === "completed" ? 0 : 1;
    });
}
