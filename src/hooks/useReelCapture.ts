/**
 * useReelCapture – React hook for the QuantneonCamera plugin.
 *
 * Orchestrates reel recording, real-time facial expression analysis,
 * Quantneon aura activation, and Quantmail VIP Reward dispatch.
 */

"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { QuantneonCamera } from "@/plugins/quantneon-camera";
import type {
  RecordingResult,
  ExpressionAnalysisResult,
  StartRecordingOptions,
  AuraConfig,
} from "@/plugins/quantneon-camera/definitions";
import { quantneon, type AuraEffectState } from "@/services/quantneon";
import { quantmail, type VipRewardToken } from "@/services/quantmail";

export interface ReelCaptureState {
  /** Whether the camera is currently recording. */
  isRecording: boolean;
  /** Current facial expression detected by MLKit. */
  currentExpression: ExpressionAnalysisResult | null;
  /** Current Quantneon aura effect state. */
  auraState: AuraEffectState;
  /** VIP Reward tokens dispatched in this session. */
  rewards: VipRewardToken[];
  /** Most recent recording result (after stopping). */
  lastResult: RecordingResult | null;
  /** Any error that occurred. */
  error: string | null;
}

export interface ReelCaptureActions {
  /** Start recording a reel. */
  startRecording: (options?: StartRecordingOptions) => Promise<void>;
  /** Stop the current recording. */
  stopRecording: () => Promise<RecordingResult | null>;
  /** Configure the Quantneon aura effect. */
  configureAura: (config: AuraConfig) => Promise<void>;
  /** Manually trigger a single-frame expression analysis. */
  analyzeExpression: () => Promise<ExpressionAnalysisResult | null>;
}

export function useReelCapture(): [ReelCaptureState, ReelCaptureActions] {
  const [isRecording, setIsRecording] = useState(false);
  const [currentExpression, setCurrentExpression] =
    useState<ExpressionAnalysisResult | null>(null);
  const [auraState, setAuraState] = useState<AuraEffectState>(
    quantneon.getState(),
  );
  const [rewards, setRewards] = useState<VipRewardToken[]>([]);
  const [lastResult, setLastResult] = useState<RecordingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const expressionListenerRef = useRef<{ remove: () => void } | null>(null);
  const auraListenerRef = useRef<{ remove: () => void } | null>(null);
  const rewardListenerRef = useRef<{ remove: () => void } | null>(null);

  // Subscribe to Quantneon aura state changes
  useEffect(() => {
    const unsubscribe = quantneon.onStateChange(setAuraState);
    return unsubscribe;
  }, []);

  // Subscribe to Quantmail reward events
  useEffect(() => {
    const unsubscribe = quantmail.onRewardDispatched((token) => {
      setRewards((prev) => [...prev, token]);
    });
    return unsubscribe;
  }, []);

  // Clean up native plugin listeners when the component unmounts mid-recording
  useEffect(() => {
    return () => {
      expressionListenerRef.current?.remove();
      auraListenerRef.current?.remove();
      rewardListenerRef.current?.remove();
      // Only deactivate the aura if it was activated during this session
      if (quantneon.getState().active) {
        quantneon.deactivate();
      }
    };
  }, []);

  const startRecording = useCallback(
    async (options?: StartRecordingOptions) => {
      try {
        setError(null);
        setCurrentExpression(null);
        setRewards([]);
        setLastResult(null);
        quantneon.deactivate();

        await QuantneonCamera.startRecording(options);
        setIsRecording(true);

        // Listen for real-time expression changes
        expressionListenerRef.current = await QuantneonCamera.addListener(
          "expressionChanged",
          (result: ExpressionAnalysisResult) => {
            setCurrentExpression(result);

            // Evaluate expression for Quantneon aura
            quantneon.evaluateExpression(result.expression, result.confidence);

            // Evaluate expression for Quantmail VIP Reward
            quantmail.evaluateAndDispatch(result.expression, result.confidence);
          },
        );

        // Listen for aura applied events from native layer
        auraListenerRef.current = await QuantneonCamera.addListener(
          "auraApplied",
          () => {
            // Aura state is managed by the quantneon service
          },
        );

        // Listen for reward dispatched events from native layer
        rewardListenerRef.current = await QuantneonCamera.addListener(
          "rewardDispatched",
          () => {
            // Rewards are managed by the quantmail service
          },
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to start recording";
        setError(message);
        setIsRecording(false);
      }
    },
    [],
  );

  const stopRecording = useCallback(async (): Promise<RecordingResult | null> => {
    try {
      setError(null);
      const result = await QuantneonCamera.stopRecording();
      setIsRecording(false);
      setLastResult(result);

      // Clean up native event listeners
      expressionListenerRef.current?.remove();
      auraListenerRef.current?.remove();
      rewardListenerRef.current?.remove();

      // Deactivate the aura after recording stops
      quantneon.deactivate();

      return result;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to stop recording";
      setError(message);
      setIsRecording(false);
      return null;
    }
  }, []);

  const configureAura = useCallback(async (config: AuraConfig) => {
    await QuantneonCamera.configureAura(config);
    quantneon.configure(config);
  }, []);

  const analyzeExpression =
    useCallback(async (): Promise<ExpressionAnalysisResult | null> => {
      try {
        const result = await QuantneonCamera.analyzeExpression();
        setCurrentExpression(result);
        return result;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Expression analysis failed";
        setError(message);
        return null;
      }
    }, []);

  const state: ReelCaptureState = {
    isRecording,
    currentExpression,
    auraState,
    rewards,
    lastResult,
    error,
  };

  const actions: ReelCaptureActions = {
    startRecording,
    stopRecording,
    configureAura,
    analyzeExpression,
  };

  return [state, actions];
}
