// Tableau de bord de gouvernance (DAO) : pouvoir de vote, création de propositions, vote, exécution.
import { useCallback, useEffect, useState } from "react";
import { JsonRpcProvider, formatEther } from "ethers";
import type { Contract } from "ethers";

type CampaignInfo = {
  id: number;
  creator: string;
  status: number; // 0 En cours, 1 Réussie, 2 Échouée, 3 Annulée
  frozen: boolean;
  withdrawalApproved: boolean;
  withdrawn: boolean;
};

type Props = {
  governance: Contract;
  token: Contract;
  account: string;
  campaigns: CampaignInfo[];
  onDone?: () => void;
};

type ProposalView = {
  id: number;
  campaignId: number;
  campaignCreator: string;
  type: number; // 0 ApproveWithdrawal, 1 FreezeCampaign
  proposer: string;
  snapshotBlock: number;
  startBlock: number;
  endBlock: number;
  forVotes: bigint;
  againstVotes: bigint;
  executed: boolean;
  quorum: bigint;
  succeeded: boolean;
  voted: boolean;
  power: bigint; // pouvoir de vote de l'utilisateur AU SNAPSHOT
};

const TYPE_LABEL = ["Approuver le retrait des fonds", "Geler la campagne"];
const LOCAL_RPC = "http://127.0.0.1:8545";

function stateOf(p: ProposalView, block: number): string {
  if (p.executed) return "Exécutée";
  if (block < p.startBlock) return "À venir";
  if (block <= p.endBlock) return "Vote en cours";
  return p.succeeded ? "Adoptée — à exécuter" : "Rejetée";
}

function readError(e: unknown): string {
  const err = e as { reason?: string; shortMessage?: string; message?: string; code?: string };
  if (err.code === "ACTION_REJECTED") return "Transaction refusée dans MetaMask.";
  return err.reason ?? err.shortMessage ?? err.message ?? "Erreur inconnue";
}

function short(address: string) {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function fmt(value: bigint) {
  return Number(formatEther(value)).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
}

export default function GovernancePanel({ governance, token, account, campaigns, onDone }: Props) {
  const [proposals, setProposals] = useState<ProposalView[]>([]);
  const [block, setBlock] = useState(0);
  const [isLocal, setIsLocal] = useState(false);
  const [balance, setBalance] = useState(0n);
  const [votes, setVotes] = useState(0n);
  const [type, setType] = useState(0);
  const [campaignId, setCampaignId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const provider = governance.runner?.provider;
      const current = provider ? await provider.getBlockNumber() : 0;
      if (provider) setIsLocal((await provider.getNetwork()).chainId === 31337n);
      setBlock(current);

      const [bal, vts, count] = await Promise.all([
        token.balanceOf(account),
        token.getVotes(account),
        governance.proposalCount(),
      ]);
      setBalance(bal as bigint);
      setVotes(vts as bigint);

      const list: ProposalView[] = [];
      for (let id = Number(count); id >= 1; id--) {
        const p = await governance.getProposal(id);
        const [quorum, succeeded, voted, power] = await Promise.all([
          governance.quorum(id),
          governance.proposalSucceeded(id),
          governance.hasVoted(id, account),
          token.getPastVotes(account, p.snapshotBlock),
        ]);
        list.push({
          id,
          campaignId: Number(p.campaignId),
          campaignCreator:
            campaigns.find((campaign) => campaign.id === Number(p.campaignId))
              ?.creator ?? "",
          type: Number(p.proposalType),
          proposer: p.proposer as string,
          snapshotBlock: Number(p.snapshotBlock),
          startBlock: Number(p.startBlock),
          endBlock: Number(p.endBlock),
          forVotes: p.forVotes as bigint,
          againstVotes: p.againstVotes as bigint,
          executed: p.executed as boolean,
          quorum: quorum as bigint,
          succeeded: succeeded as boolean,
          voted: voted as boolean,
          power: power as bigint,
        });
      }
      setProposals(list);
    } catch (e) {
      setMsg({ ok: false, text: "Lecture impossible : " + readError(e) });
    }
  }, [governance, token, account, campaigns]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load, campaigns]);

  async function run(label: string, send: () => Promise<{ wait: () => Promise<unknown> }>) {
    setBusy(true);
    setMsg(null);
    try {
      const tx = await send();
      await tx.wait();
      setMsg({ ok: true, text: label + " : confirmé ✔" });
      await load();
      onDone?.();
    } catch (e) {
      setMsg({ ok: false, text: label + " : " + readError(e) });
    } finally {
      setBusy(false);
    }
  }

  // Le contrat n'exige pas d'éligibilité à la création : l'interface ne propose que les campagnes
  // pour lesquelles la proposition pourra réellement être exécutée.
  const eligible = campaigns.filter((c) =>
    type === 0
      ? c.status === 1 &&
        !c.frozen &&
        !c.withdrawn &&
        !c.withdrawalApproved &&
        c.creator.toLowerCase() !== account.toLowerCase()
      : (c.status === 0 || c.status === 1) && !c.frozen && !c.withdrawn
  );
  const selected = eligible.some((c) => String(c.id) === campaignId) ? campaignId : String(eligible[0]?.id ?? "");

  // Démonstration locale uniquement : fait avancer la chaîne Hardhat de n blocs (hardhat_mine).
  async function mineBlocks(n: number) {
    setBusy(true);
    setMsg(null);
    try {
      const rpc = new JsonRpcProvider(LOCAL_RPC);
      await rpc.send("hardhat_mine", ["0x" + n.toString(16)]);
      rpc.destroy();
      setMsg({ ok: true, text: `${n} blocs minés.` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: "Minage impossible : " + readError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="governance-section section-container">
      <div className="section-heading">
        <div>
          <p className="tagline">GOUVERNANCE DAO</p>
          <h2>Tableau de vote</h2>
          <p className="section-description">
            Chaque vote est pondéré par vos CFD au moment du snapshot (bloc précédant la création de la proposition),
            jamais par votre solde actuel.
          </p>
        </div>
        <button className="refresh-button" onClick={() => void load()} disabled={busy}>
          Actualiser
        </button>
      </div>

      <div className="gov-summary">
        <div>
          <p>Mon solde CFD</p>
          <strong>{fmt(balance)} CFD</strong>
        </div>
        <div>
          <p>Pouvoir de vote actuel</p>
          <strong>{fmt(votes)}</strong>
        </div>
        <div>
          <p>Bloc actuel</p>
          <strong>{block}</strong>
        </div>
      </div>

      <div className="gov-form">
        <select value={type} onChange={(e) => setType(Number(e.target.value))} disabled={busy}>
          <option value={0}>{TYPE_LABEL[0]}</option>
          <option value={1}>{TYPE_LABEL[1]}</option>
        </select>
        <select value={selected} onChange={(e) => setCampaignId(e.target.value)} disabled={busy || eligible.length === 0}>
          {eligible.length === 0 && <option value="">Aucune campagne éligible</option>}
          {eligible.map((c) => (
            <option key={c.id} value={c.id}>
              Campagne #{c.id}
            </option>
          ))}
        </select>
        <button
          className="action-button"
          disabled={busy || !selected}
          onClick={() => void run("Création de la proposition", () => governance.createProposal(Number(selected), type))}
        >
          Créer la proposition
        </button>
      </div>

      {isLocal && (
        <p className="gov-note">
          Démo locale : la période de vote dure 20 blocs et le réseau Hardhat n'avance que lorsqu'on envoie une
          transaction.{" "}
          <button className="action-button secondary" disabled={busy} onClick={() => void mineBlocks(22)}>
            Avancer de 22 blocs
          </button>
        </p>
      )}

      {msg && <p className={msg.ok ? "action-message ok" : "action-message ko"}>{msg.text}</p>}

      {proposals.length === 0 ? (
        <div className="empty-state">
          <h3>Aucune proposition</h3>
          <p>Détenteurs de CFD : créez la première proposition ci-dessus.</p>
        </div>
      ) : (
        <div className="gov-grid">
          {proposals.map((p) => {
            const total = p.forVotes + p.againstVotes;
            const forPct = total > 0n ? Number((p.forVotes * 1000n) / total) / 10 : 0;
            const active = !p.executed && block >= p.startBlock && block <= p.endBlock;
            const canExecute = !p.executed && block > p.endBlock && p.succeeded;
            return (
              <article className="campaign-card" key={p.id}>
                <div className="campaign-card-top">
                  <span className="campaign-id">PROPOSITION #{p.id}</span>
                  <span className="status status-1">{stateOf(p, block)}</span>
                </div>
                <h3>{TYPE_LABEL[p.type] ?? "Proposition"}</h3>
                <p className="ipfs-reference">
                  Campagne #{p.campaignId} · proposée par {short(p.proposer)}
                </p>

                <div className="campaign-amounts">
                  <div>
                    <strong>{fmt(p.forVotes)}</strong>
                    <span>Pour</span>
                  </div>
                  <div>
                    <strong>{fmt(p.againstVotes)}</strong>
                    <span>Contre</span>
                  </div>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${forPct}%` }} />
                </div>
                <p className="progress-label">
                  {forPct.toFixed(1)} % pour · quorum requis {fmt(p.quorum)} CFD ({total >= p.quorum ? "atteint" : "non atteint"})
                </p>

                <div className="campaign-details">
                  <p className="gov-line">
                    <span>Snapshot (bloc)</span>
                    <strong>{p.snapshotBlock}</strong>
                  </p>
                  <p className="gov-line">
                    <span>Fin du vote (bloc)</span>
                    <strong>{p.endBlock}</strong>
                  </p>
                  <p className="gov-line">
                    <span>Mon poids de vote</span>
                    <strong>{fmt(p.power)} CFD</strong>
                  </p>
                </div>

                <div className="gov-buttons">
                  {active &&
                    !p.voted &&
                    p.power > 0n &&
                    !(
                      p.type === 0 &&
                      p.campaignCreator.toLowerCase() === account.toLowerCase()
                    ) && (
                    <>
                      <button
                        className="action-button"
                        disabled={busy}
                        onClick={() => void run("Vote", () => governance.castVote(p.id, true))}
                      >
                        Voter pour
                      </button>
                      <button
                        className="action-button secondary"
                        disabled={busy}
                        onClick={() => void run("Vote", () => governance.castVote(p.id, false))}
                      >
                        Voter contre
                      </button>
                    </>
                  )}
                  {active && p.voted && <p className="action-hint">Vous avez déjà voté.</p>}
                  {active &&
                    p.type === 0 &&
                    p.campaignCreator.toLowerCase() === account.toLowerCase() && (
                      <p className="action-hint">
                        Créateur de cette campagne : vous ne pouvez pas proposer ni voter
                        l’approbation de son retrait.
                      </p>
                    )}
                  {active && !p.voted && p.power === 0n && (
                    <p className="action-hint">Aucun CFD détenu au snapshot : vous ne pouvez pas voter.</p>
                  )}
                  {canExecute && (
                    <button
                      className="action-button"
                      disabled={busy}
                      onClick={() => void run("Exécution", () => governance.executeProposal(p.id))}
                    >
                      Exécuter la décision
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
