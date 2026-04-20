export type MicroInteractionType = "like" | "watch_10s" | "comment";

export interface MicroInteraction {
  type: MicroInteractionType;
  quantity?: number;
  occurredAt?: string;
}

export interface LedgerEntry {
  id: string;
  type: MicroInteractionType;
  amount: number;
  occurredAt: string;
}

export interface WithdrawalReceipt {
  id: string;
  userId: string;
  destinationWallet: string;
  amount: number;
  synchronizedAt: string;
  remainingOffChainBalance: number;
}

export interface VaultTransferReceipt {
  id: string;
  userId: string;
  amount: number;
  transferredAt: string;
  remainingOffChainBalance: number;
}

export const FRACTIONAL_VALUES: Record<MicroInteractionType, number> = {
  like: 0.001,
  watch_10s: 0.005,
  comment: 0.01,
};

interface LedgerAccount {
  balance: number;
  entries: LedgerEntry[];
}

/**
 * TokenEngine keeps a zero-gas off-chain ledger in memory and only emits
 * a synchronization receipt when users withdraw.
 */
export class TokenEngine {
  private readonly accounts = new Map<string, LedgerAccount>();

  recordInteraction(userId: string, interaction: MicroInteraction): LedgerEntry {
    const quantity = Math.max(1, Math.floor(interaction.quantity ?? 1));
    const amount = Number(
      (FRACTIONAL_VALUES[interaction.type] * quantity).toFixed(6),
    );
    const entry: LedgerEntry = {
      id: `lx-${crypto.randomUUID()}`,
      type: interaction.type,
      amount,
      occurredAt: interaction.occurredAt ?? new Date().toISOString(),
    };

    const account = this.getOrCreateAccount(userId);
    account.balance = Number((account.balance + amount).toFixed(6));
    account.entries.push(entry);

    return entry;
  }

  getBalance(userId: string): number {
    return this.getOrCreateAccount(userId).balance;
  }

  getLedger(userId: string): LedgerEntry[] {
    return [...this.getOrCreateAccount(userId).entries];
  }

  withdraw(
    userId: string,
    amount: number,
    destinationWallet: string,
  ): WithdrawalReceipt {
    const normalizedAmount = Number(Math.max(0, amount).toFixed(6));
    const account = this.getOrCreateAccount(userId);

    if (normalizedAmount === 0) {
      throw new Error("Withdrawal amount must be greater than zero.");
    }
    if (normalizedAmount > account.balance) {
      throw new Error("Insufficient off-chain balance.");
    }

    account.balance = Number((account.balance - normalizedAmount).toFixed(6));

    return {
      id: `wd-${crypto.randomUUID()}`,
      userId,
      destinationWallet,
      amount: normalizedAmount,
      synchronizedAt: new Date().toISOString(),
      remainingOffChainBalance: account.balance,
    };
  }

  transferToVault(userId: string, amount: number): VaultTransferReceipt {
    const normalizedAmount = Number(Math.max(0, amount).toFixed(6));
    const account = this.getOrCreateAccount(userId);
    if (normalizedAmount === 0) {
      throw new Error("Transfer amount must be greater than zero.");
    }
    if (normalizedAmount > account.balance) {
      throw new Error("Insufficient off-chain balance.");
    }

    account.balance = Number((account.balance - normalizedAmount).toFixed(6));

    return {
      id: `vt-${crypto.randomUUID()}`,
      userId,
      amount: normalizedAmount,
      transferredAt: new Date().toISOString(),
      remainingOffChainBalance: account.balance,
    };
  }

  private getOrCreateAccount(userId: string): LedgerAccount {
    const existing = this.accounts.get(userId);
    if (existing) return existing;

    const created: LedgerAccount = { balance: 0, entries: [] };
    this.accounts.set(userId, created);
    return created;
  }
}
