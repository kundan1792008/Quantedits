"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Wallet, TrendingUp } from "lucide-react";
import { TokenEngine } from "@/services/TokenEngine";
import {
  AutoStakingVault,
  DEFAULT_AUTO_STAKING_APY,
} from "@/services/AutoStaking";

export interface WealthDashboardProps {
  userId: string;
  likes: number;
  watch10sBlocks: number;
  comments: number;
}

interface WealthState {
  offChainBalance: number;
  stakedBalance: number;
  apy: number;
  totalYieldEarned: number;
  lostPotential30d: number;
}

const sharedTokenEngine = new TokenEngine();
const sharedVault = new AutoStakingVault();

function formatTk(amount: number): string {
  return `${amount.toFixed(4)} TK`;
}

function buildSparklinePoints(values: number[]): string {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  return values
    .map((value, idx) => {
      const x = (idx / Math.max(1, values.length - 1)) * 100;
      const normalized = max === min ? 0.5 : (value - min) / (max - min);
      const y = 40 - normalized * 32;
      return `${x},${y}`;
    })
    .join(" ");
}

export default function WealthDashboard({
  userId,
  likes,
  watch10sBlocks,
  comments,
}: WealthDashboardProps) {
  const tokenEngineRef = useRef(sharedTokenEngine);
  const vaultRef = useRef(sharedVault);
  const processedRef = useRef({ likes: 0, watch10sBlocks: 0, comments: 0 });
  const [state, setState] = useState<WealthState>({
    offChainBalance: 0,
    stakedBalance: 0,
    apy: DEFAULT_AUTO_STAKING_APY,
    totalYieldEarned: 0,
    lostPotential30d: 0,
  });

  useEffect(() => {
    const deltaLikes = Math.max(0, likes - processedRef.current.likes);
    const deltaWatches = Math.max(
      0,
      watch10sBlocks - processedRef.current.watch10sBlocks,
    );
    const deltaComments = Math.max(0, comments - processedRef.current.comments);

    let newlyEarned = 0;
    if (deltaLikes > 0) {
      const entry = tokenEngineRef.current.recordInteraction(userId, {
        type: "like",
        quantity: deltaLikes,
      });
      newlyEarned += entry.amount;
    }
    if (deltaWatches > 0) {
      const entry = tokenEngineRef.current.recordInteraction(userId, {
        type: "watch_10s",
        quantity: deltaWatches,
      });
      newlyEarned += entry.amount;
    }
    if (deltaComments > 0) {
      const entry = tokenEngineRef.current.recordInteraction(userId, {
        type: "comment",
        quantity: deltaComments,
      });
      newlyEarned += entry.amount;
    }

    newlyEarned = Number(newlyEarned.toFixed(6));
    if (newlyEarned > 0) {
      tokenEngineRef.current.transferToVault(userId, newlyEarned);
      vaultRef.current.deposit(userId, newlyEarned);
    }

    processedRef.current = { likes, watch10sBlocks, comments };

    const stakingSnapshot = vaultRef.current.getSnapshot(userId);
    const projection = vaultRef.current.project(userId, 30, 0.3);
    setState({
      offChainBalance: tokenEngineRef.current.getBalance(userId),
      stakedBalance: stakingSnapshot.principal,
      apy: stakingSnapshot.apy,
      totalYieldEarned: stakingSnapshot.totalYieldEarned,
      lostPotential30d: projection.lostPotential,
    });
  }, [comments, likes, userId, watch10sBlocks]);

  const graphPoints = useMemo(() => {
    const base = Math.max(state.stakedBalance, 0);
    const points: number[] = [];
    for (let day = 0; day < 7; day += 1) {
      const projected = base * (1 + state.apy) ** (day / 365);
      points.push(Number(projected.toFixed(6)));
    }
    return buildSparklinePoints(points);
  }, [state.apy, state.stakedBalance]);

  return (
    <section
      aria-label="Wealth accumulation dashboard"
      className="rounded-xl p-4"
      style={{ background: "#13131A", border: "1px solid #1E1E2E" }}
    >
      <header className="flex items-center gap-2 mb-3">
        <Wallet size={14} className="text-[#74c0fc]" />
        <h3 className="text-xs font-semibold uppercase tracking-widest text-[#74c0fc]">
          Wealth dashboard
        </h3>
      </header>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg px-3 py-2 bg-[#0f111a] border border-[#1E1E2E]">
          <p className="text-[10px] uppercase tracking-widest text-[#5a5a7a]">
            Off-chain ledger
          </p>
          <p className="text-sm font-semibold text-[#E8E8F0]">
            {formatTk(state.offChainBalance)}
          </p>
        </div>
        <div className="rounded-lg px-3 py-2 bg-[#0f111a] border border-[#1E1E2E]">
          <p className="text-[10px] uppercase tracking-widest text-[#5a5a7a]">
            Auto-staked
          </p>
          <p className="text-sm font-semibold text-[#4ade80]">
            {formatTk(state.stakedBalance)}
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-lg p-3 bg-[#0f111a] border border-[#1E1E2E]">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] uppercase tracking-widest text-[#5a5a7a]">
            7-day compounding curve
          </p>
          <p className="text-[11px] text-[#9ae6b4]">
            APY {(state.apy * 100).toFixed(2)}%
          </p>
        </div>
        <svg viewBox="0 0 100 40" className="w-full h-14">
          <polyline
            fill="none"
            stroke="#4ade80"
            strokeWidth="2"
            points={graphPoints}
          />
        </svg>
        <p className="text-[11px] text-[#94a3b8]">
          Yield earned: {formatTk(state.totalYieldEarned)}
        </p>
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="mt-3 rounded-lg p-3 border border-[#2a2a44]"
        style={{ background: "rgba(59, 130, 246, 0.08)" }}
      >
        <p className="flex items-center gap-1 text-[11px] text-[#bfdbfe]">
          <TrendingUp size={12} />
          Interaction-rate sensitivity
        </p>
        <p className="text-[11px] text-[#cbd5e1] mt-1">
          30-day lost potential at a 30% interaction slowdown:{" "}
          <span className="font-semibold text-[#f8fafc]">
            {formatTk(state.lostPotential30d)}
          </span>
        </p>
      </motion.div>
    </section>
  );
}
