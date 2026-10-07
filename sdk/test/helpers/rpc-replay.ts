// Preload (`node --import`) that answers JSON-RPC requests from a recorded file instead of the network,
// so a script that reads Sepolia can run offline in tests. Each request is matched on its method and
// params; a request that is not in the file fails (it is never sent to the network).
//
//   RPC_REPLAY=<file>   answer from <file>, with Date.now() moved back to the file's recordedAt
//   RPC_RECORD=<file>   send to the real node and write every answer to <file> on exit (to refresh it)
// In-process tests use `replayFetch` instead.
import { readFileSync, writeFileSync } from "node:fs";

type Call = { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown[] };
type Answer = { result?: unknown; error?: unknown };

const keyOf = (c: Call) => `${c.method} ${JSON.stringify(c.params ?? [])}`;
const replay = process.env.RPC_REPLAY;
const record = process.env.RPC_RECORD;
const realFetch = globalThis.fetch;

if (replay || record) {
  const file = replay ? JSON.parse(readFileSync(replay, "utf8")) : undefined;
  const answers: Record<string, Answer> = file ? file.answers : {};
  // Replayed answers are as of the recording, so the clock is moved back to it: the verifier's head-age limit
  // (300 s on Sepolia) compares the recorded head block with this clock.
  if (file?.recordedAt) {
    const realNow = Date.now.bind(Date);
    const offset = Date.parse(file.recordedAt) - realNow();
    Date.now = () => realNow() + offset;
  }
  if (record) {
    process.on("exit", () =>
      writeFileSync(
        record,
        JSON.stringify({ note: "Recorded JSON-RPC answers (sdk/test/helpers/rpc-replay.ts).", recordedAt: new Date().toISOString(), answers }, null, 1) + "\n",
      ),
    );
  }
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : "")));
    const calls: Call[] = Array.isArray(body) ? body : [body];
    let out: (Answer & { jsonrpc: "2.0"; id: Call["id"] })[];
    if (record) {
      const res = await realFetch(input, init);
      const json = await res.clone().json();
      const list = Array.isArray(json) ? json : [json];
      for (const c of calls) {
        const a = list.find((x: { id: unknown }) => x.id === c.id);
        // A block's transaction hashes are dropped to keep the file small; the verifier does not read them.
        const result = c.method === "eth_getBlockByNumber" && a?.result ? { ...a.result, transactions: [] } : a?.result;
        if (a && a.error === undefined) answers[keyOf(c)] = { result };
      }
      return res;
    }
    out = calls.map((c) => answerOf(answers, c));
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { headers: { "content-type": "application/json" } });
  };
}

function answerOf(answers: Record<string, Answer>, c: Call): Answer & { jsonrpc: "2.0"; id: Call["id"] } {
  const a = answers[keyOf(c)];
  if (!a) throw new Error(`rpc-replay: no recorded answer for ${keyOf(c)}`);
  return { jsonrpc: "2.0", id: c.id, ...a };
}

/** A `fetch` that answers from `file` (a recording made with RPC_RECORD), for in-process tests. */
export function replayFetch(file: string): typeof fetch {
  const answers: Record<string, Answer> = JSON.parse(readFileSync(file, "utf8")).answers;
  return async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : "")));
    const out = (Array.isArray(body) ? body : [body]).map((c: Call) => answerOf(answers, c));
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { headers: { "content-type": "application/json" } });
  };
}
