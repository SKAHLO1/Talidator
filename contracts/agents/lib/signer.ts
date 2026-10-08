import { encodeFunctionData, type Abi, type Address, type Hex, type LocalAccount, type TypedDataDefinition } from "viem";
import { chain, confirm, wallet } from "./clients";

/**
 * What an agent needs from its wallet: sign an EIP-712 vote and send a contract call.
 * Implemented by a local key (mnemonic / private key) or a Privy server wallet (see privy.ts).
 */
export interface AgentSigner {
  address: Address;
  kind: "local" | "privy";
  signTypedData(typedData: TypedDataDefinition): Promise<Hex>;
  send(tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex>;
}

export function localSigner(account: LocalAccount): AgentSigner {
  return {
    address: account.address,
    kind: "local",
    signTypedData: (td) => account.signTypedData(td),
    send: ({ to, data, value }) => wallet(account).sendTransaction({ to, data, value, chain, account }),
  };
}

/** Encode a contract call, send it from `signer`, wait for success. */
export async function call<const abi extends Abi>(
  signer: AgentSigner,
  contract: { address: Address; abi: abi },
  functionName: string,
  args: readonly unknown[],
  value?: bigint,
) {
  const data = encodeFunctionData({ abi: contract.abi as Abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  return confirm(await signer.send({ to: contract.address, data, value }));
}
