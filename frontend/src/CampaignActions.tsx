// Actions d'une campagne : contribuer, finaliser, se faire rembourser.
// Composant autonome : à placer dans frontend/src/ et à afficher dans la carte de chaque campagne :
//   <CampaignActions campaignId={id} account={account} crowdfundingAddress={...} tokenAddress={...} onDone={reload} />
// Il relit lui-même la campagne (getCampaign) : aucune autre modification de App.tsx n'est nécessaire.
import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, formatEther, parseEther } from "ethers";
import type { Eip1193Provider } from "ethers";
import CrowdfundingAbi from "./abi/Crowdfunding.json";
import TokenAbi from "./abi/CFDToken.json";

// Statuts du contrat : enum Crowdfunding.Status { Active, Successful, Failed, Cancelled }
const ACTIVE = 0n;
const SUCCESSFUL = 1n;
const FAILED = 2n;
const CANCELLED = 3n;

type Props = {
  campaignId: bigint | number;
  account: string; // compte MetaMask connecté
  crowdfundingAddress: string;
  tokenAddress: string;
  onDone?: () => void; // appelé après chaque transaction confirmée (recharger la liste)
};

type View = {
  beneficiary: string;
  status: bigint;
  frozen: boolean;
  withdrawalApproved: boolean;
  withdrawn: boolean;
  deadline: bigint;
  paused: boolean;
  mine: bigint; // ma contribution (wei)
  alreadyRefunded: boolean;
  rate: bigint; // CFD_PER_ETH
  cfd: bigint; // mon solde CFD
};

function readError(e: unknown): string {
  const err = e as { reason?: string; shortMessage?: string; message?: string; code?: string };
  if (err.code === "ACTION_REJECTED") return "Transaction refusée dans MetaMask.";
  return err.reason ?? err.shortMessage ?? err.message ?? "Erreur inconnue";
}

export default function CampaignActions({ campaignId, account, crowdfundingAddress, tokenAddress, onDone }: Props) {
  const [view, setView] = useState<View | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(0n);

  const getSigner = useCallback(async () => {
    const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
    if (!eth) throw new Error("MetaMask non détecté");
    return new BrowserProvider(eth).getSigner();
  }, []);

  const load = useCallback(async () => {
    try {
      const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
      if (!eth) return;
      const provider = new BrowserProvider(eth);
      const cf = new Contract(crowdfundingAddress, CrowdfundingAbi, provider);
      const token = new Contract(tokenAddress, TokenAbi, provider);
      const [c, mine, done, rate, cfd, paused] = await Promise.all([
        cf.getCampaign(campaignId),
        cf.contributions(campaignId, account),
        cf.refunded(campaignId, account),
        cf.CFD_PER_ETH(),
        token.balanceOf(account),
        cf.paused(),
      ]);
      setView({
        beneficiary: c.beneficiary as string,
        status: c.status as bigint,
        frozen: c.frozen as boolean,
        withdrawalApproved: c.withdrawalApproved as boolean,
        withdrawn: c.withdrawn as boolean,
        deadline: c.deadline as bigint,
        paused: paused as boolean,
        mine: mine as bigint,
        alreadyRefunded: done as boolean,
        rate: rate as bigint,
        cfd: cfd as bigint,
      });
    } catch (e) {
      setMsg({ ok: false, text: "Lecture impossible : " + readError(e) });
    }
  }, [campaignId, account, crowdfundingAddress, tokenAddress]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(BigInt(Math.floor(Date.now() / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Exécute une ou plusieurs transactions, puis recharge.
  async function run(label: string, steps: Array<() => Promise<{ wait: () => Promise<unknown> }>>) {
    setBusy(true);
    setMsg(null);
    try {
      for (const step of steps) {
        const tx = await step();
        await tx.wait();
      }
      setMsg({ ok: true, text: label + " : confirmé ✔" });
      setAmount("");
      await load();
      onDone?.();
    } catch (e) {
      setMsg({ ok: false, text: label + " : " + readError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function contribute() {
    let value: bigint;
    try {
      value = parseEther(amount);
    } catch {
      setMsg({ ok: false, text: "Montant invalide." });
      return;
    }
    if (value <= 0n) {
      setMsg({ ok: false, text: "Le montant doit être supérieur à 0." });
      return;
    }
    await run("Contribution", [
      async () => {
        const cf = new Contract(crowdfundingAddress, CrowdfundingAbi, await getSigner());
        return cf.contribute(campaignId, { value });
      },
    ]);
  }

  async function finalize() {
    await run("Finalisation", [
      async () => {
        const cf = new Contract(crowdfundingAddress, CrowdfundingAbi, await getSigner());
        return cf.finalizeCampaign(campaignId);
      },
    ]);
  }

  async function withdrawFunds() {
    await run("Transfert à la trésorerie", [
      async () => {
        const cf = new Contract(
          crowdfundingAddress,
          CrowdfundingAbi,
          await getSigner()
        );
        return cf.withdrawFunds(campaignId);
      },
    ]);
  }

  // Le contrat appelle token.burnFrom(msg.sender, ...), qui consomme une allowance :
  // il faut donc d'abord approuver Crowdfunding pour le montant de CFD à détruire.
  async function refund() {
    if (!view) return;
    const toBurn = view.mine * view.rate;
    await run("Remboursement", [
      async () => {
        const token = new Contract(tokenAddress, TokenAbi, await getSigner());
        return token.approve(crowdfundingAddress, toBurn);
      },
      async () => {
        const cf = new Contract(crowdfundingAddress, CrowdfundingAbi, await getSigner());
        return cf.refund(campaignId);
      },
    ]);
  }

  if (!view) return <p className="action-message">{msg?.text ?? "Chargement…"}</p>;

  const deadlinePassed = now >= view.deadline;
  const canContribute =
    view.status === ACTIVE &&
    !view.frozen &&
    !deadlinePassed &&
    !view.paused;
  const canFinalize = view.status === ACTIVE && deadlinePassed;
  const canWithdraw =
    view.status === SUCCESSFUL &&
    view.withdrawalApproved &&
    !view.frozen &&
    !view.withdrawn &&
    !view.paused &&
    account.toLowerCase() === view.beneficiary.toLowerCase();
  const canRefund = (view.status === FAILED || view.status === CANCELLED) && view.mine > 0n && !view.alreadyRefunded;
  const preview = (() => {
    try {
      return amount ? formatEther(parseEther(amount) * view.rate) : "";
    } catch {
      return "";
    }
  })();

  return (
    <div className="campaign-actions">
      <p className="actions-summary">
        Ma contribution : <strong>{formatEther(view.mine)} ETH</strong> · Mon solde :{" "}
        <strong>{formatEther(view.cfd)} CFD</strong>
      </p>

      {canContribute && (
        <div className="actions-row">
          <input
            type="number"
            min="0"
            step="any"
            placeholder="Montant en ETH"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
          />
          <button className="action-button" onClick={() => void contribute()} disabled={busy || !amount}>
            {busy ? "En cours…" : "Contribuer"}
          </button>
        </div>
      )}
      {canContribute && preview && <p className="action-hint">→ vous recevrez {preview} CFD</p>}

      {canFinalize && (
        <button className="action-button" onClick={() => void finalize()} disabled={busy}>
          Date limite passée : finaliser la campagne
        </button>
      )}

      {canWithdraw && (
        <button
          className="action-button"
          onClick={() => void withdrawFunds()}
          disabled={busy}
        >
          {busy ? "En cours…" : "Retirer les fonds vers la trésorerie"}
        </button>
      )}

      {view.status === SUCCESSFUL &&
        view.withdrawalApproved &&
        !view.withdrawn &&
        !view.paused &&
        account.toLowerCase() !== view.beneficiary.toLowerCase() && (
          <p className="action-hint">
            Seul le bénéficiaire peut transférer les fonds à la trésorerie.
          </p>
        )}

      {canRefund && (
        <button className="action-button" onClick={() => void refund()} disabled={busy}>
          {busy ? "En cours…" : `Me faire rembourser ${formatEther(view.mine)} ETH`}
        </button>
      )}

      {msg && <p className={msg.ok ? "action-message ok" : "action-message ko"}>{msg.text}</p>}
    </div>
  );
}
