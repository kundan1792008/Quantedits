export interface StakingSnapshot {
  userId: string;
  principal: number;
  apy: number;
  totalYieldEarned: number;
  updatedAt: string;
}

export interface GrowthProjection {
  projectedBalance: number;
  projectedWithLowerInteraction: number;
  lostPotential: number;
}

interface VaultAccount {
  principal: number;
  apy: number;
  totalYieldEarned: number;
  updatedAt: number;
}

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
export const DEFAULT_AUTO_STAKING_APY = 0.12;

export class AutoStakingVault {
  private readonly accounts = new Map<string, VaultAccount>();

  deposit(
    userId: string,
    amount: number,
    apy = DEFAULT_AUTO_STAKING_APY,
  ): StakingSnapshot {
    const account = this.getOrCreateAccount(userId, apy);
    this.accrueToNow(account);

    const normalized = Number(Math.max(0, amount).toFixed(6));
    account.principal = Number((account.principal + normalized).toFixed(6));
    account.apy = apy;

    return this.toSnapshot(userId, account);
  }

  getSnapshot(userId: string): StakingSnapshot {
    const account = this.getOrCreateAccount(userId);
    this.accrueToNow(account);
    return this.toSnapshot(userId, account);
  }

  project(userId: string, days: number, lowerInteractionRate = 0.3): GrowthProjection {
    const account = this.getOrCreateAccount(userId);
    this.accrueToNow(account);

    const years = Math.max(0, days) / 365;
    const baseline = account.principal * (1 + account.apy) ** years;
    const dampener = Math.min(1, Math.max(0, lowerInteractionRate));
    const slowerApy = account.apy * (1 - dampener);
    const reduced = account.principal * (1 + slowerApy) ** years;

    return {
      projectedBalance: Number(baseline.toFixed(6)),
      projectedWithLowerInteraction: Number(reduced.toFixed(6)),
      lostPotential: Number((baseline - reduced).toFixed(6)),
    };
  }

  private accrueToNow(account: VaultAccount): void {
    const now = Date.now();
    const elapsedSec = Math.max(0, (now - account.updatedAt) / 1000);
    if (elapsedSec <= 0 || account.principal <= 0) {
      account.updatedAt = now;
      return;
    }

    const growthFactor = (1 + account.apy) ** (elapsedSec / SECONDS_PER_YEAR);
    const nextPrincipal = account.principal * growthFactor;
    const yieldEarned = nextPrincipal - account.principal;

    account.principal = Number(nextPrincipal.toFixed(6));
    account.totalYieldEarned = Number(
      (account.totalYieldEarned + yieldEarned).toFixed(6),
    );
    account.updatedAt = now;
  }

  private getOrCreateAccount(
    userId: string,
    apy = DEFAULT_AUTO_STAKING_APY,
  ): VaultAccount {
    const existing = this.accounts.get(userId);
    if (existing) return existing;

    const created: VaultAccount = {
      principal: 0,
      apy,
      totalYieldEarned: 0,
      updatedAt: Date.now(),
    };
    this.accounts.set(userId, created);
    return created;
  }

  private toSnapshot(userId: string, account: VaultAccount): StakingSnapshot {
    return {
      userId,
      principal: account.principal,
      apy: account.apy,
      totalYieldEarned: account.totalYieldEarned,
      updatedAt: new Date(account.updatedAt).toISOString(),
    };
  }
}
