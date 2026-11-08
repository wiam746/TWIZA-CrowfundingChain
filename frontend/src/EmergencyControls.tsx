import { useCallback, useEffect, useState } from "react";
import type { Contract } from "ethers";

type Props = {
  crowdfunding: Contract;
  treasury: Contract;
  account: string;
  onDone?: () => void;
};

type CircuitBreakerState = {
  canPause: boolean;
  paused: boolean;
};

function readError(error: unknown): string {
  const err = error as {
    reason?: string;
    shortMessage?: string;
    message?: string;
    code?: string;
  };
  if (err.code === "ACTION_REJECTED") {
    return "Transaction refusée dans MetaMask.";
  }
  return err.reason ?? err.shortMessage ?? err.message ?? "Erreur inconnue.";
}

export default function EmergencyControls({
  crowdfunding,
  treasury,
  account,
  onDone,
}: Props) {
  const [crowdfundingState, setCrowdfundingState] =
    useState<CircuitBreakerState | null>(null);
  const [treasuryState, setTreasuryState] =
    useState<CircuitBreakerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const load = useCallback(async () => {
    try {
      const [
        crowdfundingRole,
        treasuryRole,
        crowdfundingPaused,
        treasuryPaused,
      ] = await Promise.all([
        crowdfunding.PAUSER_ROLE() as Promise<string>,
        treasury.PAUSER_ROLE() as Promise<string>,
        crowdfunding.paused() as Promise<boolean>,
        treasury.paused() as Promise<boolean>,
      ]);
      const [canPauseCrowdfunding, canPauseTreasury] = await Promise.all([
        crowdfunding.hasRole(crowdfundingRole, account) as Promise<boolean>,
        treasury.hasRole(treasuryRole, account) as Promise<boolean>,
      ]);
      setCrowdfundingState({
        canPause: canPauseCrowdfunding,
        paused: crowdfundingPaused,
      });
      setTreasuryState({
        canPause: canPauseTreasury,
        paused: treasuryPaused,
      });
    } catch (error) {
      setMessage({
        ok: false,
        text: `Lecture des contrôles d'urgence impossible : ${readError(error)}`,
      });
    }
  }, [crowdfunding, treasury, account]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function togglePause(
    contract: Contract,
    contractName: string,
    paused: boolean
  ) {
    setBusy(true);
    setMessage(null);
    try {
      const transaction = await contract.getFunction(
        paused ? "unpause" : "pause"
      )();
      await transaction.wait();
      setMessage({
        ok: true,
        text: `${contractName} ${paused ? "remis en service" : "mis en pause"}.`,
      });
      await load();
      onDone?.();
    } catch (error) {
      setMessage({
        ok: false,
        text: `${contractName} : ${readError(error)}`,
      });
    } finally {
      setBusy(false);
    }
  }

  const canManage =
    crowdfundingState?.canPause || treasuryState?.canPause;
  if (!canManage && !message) return null;

  return (
    <section className="emergency-section section-container">
      <div className="section-heading">
        <div>
          <p className="tagline">SÉCURITÉ</p>
          <h2>Circuit breaker</h2>
          <p className="section-description">
            Les actions ne sont disponibles qu’aux comptes possédant le rôle
            PAUSER correspondant.
          </p>
        </div>
      </div>

      <div className="emergency-controls">
        {crowdfundingState?.canPause && (
          <div className="emergency-control">
            <div>
              <h3>Crowdfunding</h3>
              <p>{crowdfundingState.paused ? "En pause" : "Actif"}</p>
            </div>
            <button
              className="action-button secondary"
              disabled={busy}
              onClick={() =>
                void togglePause(
                  crowdfunding,
                  "Crowdfunding",
                  crowdfundingState.paused
                )
              }
            >
              {crowdfundingState.paused ? "Reprendre" : "Mettre en pause"}
            </button>
          </div>
        )}

        {treasuryState?.canPause && (
          <div className="emergency-control">
            <div>
              <h3>Trésorerie</h3>
              <p>{treasuryState.paused ? "En pause" : "Active"}</p>
            </div>
            <button
              className="action-button secondary"
              disabled={busy}
              onClick={() =>
                void togglePause(treasury, "Treasury", treasuryState.paused)
              }
            >
              {treasuryState.paused ? "Reprendre" : "Mettre en pause"}
            </button>
          </div>
        )}
      </div>

      {message && (
        <p className={message.ok ? "action-message ok" : "action-message ko"}>
          {message.text}
        </p>
      )}
    </section>
  );
}
