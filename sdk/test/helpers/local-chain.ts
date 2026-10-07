// Local anvil chain with both contracts deployed, for SDK integration tests.
// Needs Foundry (anvil) and `forge build` output in contracts/out.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  type Hex,
  type PublicClient,
  type TestClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { emissionsClaimRegistryAbi, verifierAllowlistAbi } from "../../abi.ts";
import { ChainReader, type Deployment } from "../../chain.ts";

// anvil's default development keys (public, test-only)
const ANVIL_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
];

function bytecode(name: string): Hex {
  const art = JSON.parse(
    readFileSync(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"),
  );
  return art.bytecode.object as Hex;
}

export interface LocalChain {
  proc: ChildProcess;
  rpc: string;
  pub: PublicClient;
  test: TestClient;
  owner: PrivateKeyAccount;
  watcher: PrivateKeyAccount;
  verifier: PrivateKeyAccount;
  supplier: PrivateKeyAccount;
  impostor: PrivateKeyAccount;
  other: PrivateKeyAccount;
  wallet: (a: PrivateKeyAccount) => WalletClient;
  deployment: Deployment;
  reader: ChainReader;
  stop: () => void;
}

/** `anvilArgs`: extra anvil flags (the long-chain test uses `--hardfork cancun --prune-history` to mine fast). */
export async function startLocalChain(port: number, anvilArgs: string[] = []): Promise<LocalChain> {
  const proc = spawn("anvil", ["--port", String(port), "--silent", "--timestamp", "1790000000", ...anvilArgs], { stdio: "ignore" });
  const rpc = `http://127.0.0.1:${port}`;
  const pub = createPublicClient({ chain: foundry, transport: http(rpc) }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const [owner, watcher, verifier, supplier, impostor, other] = ANVIL_KEYS.map((k) => privateKeyToAccount(k));
  const wallet = (a: PrivateKeyAccount) => createWalletClient({ account: a, chain: foundry, transport: http(rpc) });
  const test = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpc) });

  const ow = wallet(owner);
  const h1 = await ow.deployContract({
    abi: verifierAllowlistAbi,
    bytecode: bytecode("VerifierAllowlist"),
    args: [owner.address, watcher.address],
    account: owner,
    chain: foundry,
  });
  const r1 = await pub.waitForTransactionReceipt({ hash: h1 });
  const allowlist = r1.contractAddress as Hex;
  const h2 = await ow.deployContract({
    abi: emissionsClaimRegistryAbi,
    bytecode: bytecode("EmissionsClaimRegistry"),
    args: [allowlist],
    account: owner,
    chain: foundry,
  });
  const r2 = await pub.waitForTransactionReceipt({ hash: h2 });
  // The tests set block times (days ahead, or minutes behind the clock between transactions): no head-age limit.
  const deployment: Deployment = {
    chainId: 31337,
    maxHeadAgeSec: Infinity,
    contracts: {
      VerifierAllowlist: { address: allowlist, block: Number(r1.blockNumber) },
      EmissionsClaimRegistry: { address: r2.contractAddress as Hex, block: Number(r2.blockNumber) },
    },
  };
  return {
    proc,
    rpc,
    pub,
    test,
    owner,
    watcher,
    verifier,
    supplier,
    impostor,
    other,
    wallet,
    deployment,
    reader: ChainReader.forRpc(deployment, [rpc], foundry),
    stop: () => proc.kill(),
  };
}

/** Sends a contract write and waits for it; throws on revert. */
export async function send(
  chain: LocalChain,
  from: PrivateKeyAccount,
  target: "allowlist" | "registry",
  functionName: string,
  args: readonly unknown[],
) {
  const address =
    target === "allowlist"
      ? chain.deployment.contracts.VerifierAllowlist.address
      : chain.deployment.contracts.EmissionsClaimRegistry.address;
  const abi = target === "allowlist" ? verifierAllowlistAbi : emissionsClaimRegistryAbi;
  const { request } = await chain.pub.simulateContract({ address, abi, functionName, args, account: from } as never);
  const hash = await chain.wallet(from).writeContract(request as never);
  return chain.pub.waitForTransactionReceipt({ hash });
}
