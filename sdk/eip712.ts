// EIP-712 signature of the verification body over the credential. The contract does not check it;
// it travels with the credential so a buyer can verify offline who issued it.
import { recoverTypedDataAddress, type LocalAccount, type WalletClient } from "viem";
import { SEPOLIA_CHAIN_ID, type Hex } from "./credential.ts";

export const EIP712_TYPES = {
  EmissionsCredential: [
    { name: "credSAID", type: "string" },
    { name: "supplierCommit", type: "bytes32" },
    { name: "verifiedKg", type: "uint96" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export interface EmissionsCredentialMessage {
  credSAID: string;
  supplierCommit: Hex;
  verifiedKg: bigint;
  validUntil: bigint;
}

export function domainOf(registry: Hex, chainId: number = SEPOLIA_CHAIN_ID) {
  return { name: "CarbonLEI", version: "1", chainId, verifyingContract: registry } as const;
}

export function typedDataOf(registry: Hex, message: EmissionsCredentialMessage, chainId?: number) {
  return {
    domain: domainOf(registry, chainId),
    types: EIP712_TYPES,
    primaryType: "EmissionsCredential" as const,
    message,
  };
}

/** Signs with a local account (tests, CLI). */
export async function signCredential(
  account: LocalAccount,
  registry: Hex,
  message: EmissionsCredentialMessage,
  chainId?: number,
): Promise<Hex> {
  return account.signTypedData(typedDataOf(registry, message, chainId));
}

/** Signs with a connected wallet (browser). */
export async function signCredentialWithWallet(
  wallet: WalletClient,
  account: Hex,
  registry: Hex,
  message: EmissionsCredentialMessage,
): Promise<Hex> {
  return wallet.signTypedData({ account, ...typedDataOf(registry, message, wallet.chain?.id) });
}

export async function recoverIssuer(
  registry: Hex,
  message: EmissionsCredentialMessage,
  signature: Hex,
  chainId?: number,
): Promise<Hex> {
  return recoverTypedDataAddress({ ...typedDataOf(registry, message, chainId), signature });
}
