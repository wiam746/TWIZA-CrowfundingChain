import { useCallback, useEffect, useState } from "react";
import { formatEther, parseEther } from "ethers";
import type { Contract as EthersContract } from "ethers";
import type { CampaignMetadata } from "./ipfs";

type CampaignInfo = {
  id: number;
  creator: string;
  ipfsHash: string;
};

type Props = {
  treasury: EthersContract;
  account: string;
  campaigns: CampaignInfo[];
  campaignMetadata: Record<string, CampaignMetadata>;
  onDone?: () => void;
};

type FundedCampaign = {
  id: number;
  beneficiary: string;
  creator: string;
  balance: bigint;
};

type WithdrawalTransaction = {
  id: number;
  campaignId: number;
  recipient: string;
  amount: bigint;
  approvals: bigint;
  requiredApprovals: bigint;
  executed: boolean;
  approvedByMe: boolean;
  isCampaignCreator: boolean;
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

function short(address: string) {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

export default function TreasuryPanel({
  treasury,
  account,
  campaigns,
  campaignMetadata,
  onDone,
}: Props) {
  const [isOwner, setIsOwner] = useState(false);
  const [paused, setPaused] = useState(false);
  const [threshold, setThreshold] = useState(0n);
  const [fundedCampaigns, setFundedCampaigns] = useState<FundedCampaign[]>([]);
  const [transactions, setTransactions] = useState<WithdrawalTransaction[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState("");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [owner, contractPaused, contractThreshold, transactionCount] =
        await Promise.all([
          treasury.isOwner(account) as Promise<boolean>,
          treasury.paused() as Promise<boolean>,
          treasury.threshold() as Promise<bigint>,
          treasury.transactionCount() as Promise<bigint>,
        ]);
      setIsOwner(owner);
      setPaused(contractPaused);
      setThreshold(contractThreshold);

      const funded = await Promise.all(
        campaigns.map(async ({ id, creator }) => {
          const [balance, beneficiary] = await Promise.all([
            treasury.campaignBalances(id) as Promise<bigint>,
            treasury.campaignBeneficiaries(id) as Promise<string>,
          ]);
          return { id, balance, beneficiary, creator };
        })
      );
      const available = funded.filter((campaign) => campaign.balance > 0n);
      setFundedCampaigns(available);
      setSelectedCampaign((current) =>
        available.some((campaign) => String(campaign.id) === current)
          ? current
          : String(available[0]?.id ?? "")
      );

      const count = Number(transactionCount);
      const withdrawalTransactions = await Promise.all(
        Array.from({ length: count }, async (_, index) => {
          const id = count - index;
          const [transaction, approvedByMe, requiredApprovals] =
            await Promise.all([
            treasury.transactions(id),
            treasury.approved(id, account) as Promise<boolean>,
            treasury.getRequiredApprovals(id) as Promise<bigint>,
          ]);
          const campaign = campaigns.find(
            (item) => item.id === Number(transaction.campaignId)
          );
          return {
            id,
            campaignId: Number(transaction.campaignId),
            recipient: transaction.recipient as string,
            amount: transaction.amount as bigint,
            approvals: transaction.approvals as bigint,
            requiredApprovals,
            executed: transaction.executed as boolean,
            approvedByMe,
            isCampaignCreator:
              campaign?.creator.toLowerCase() === account.toLowerCase(),
          };
        })
      );
      setTransactions(withdrawalTransactions);
    } catch (error) {
      setMessage({
        ok: false,
        text: `Lecture de la trésorerie impossible : ${readError(error)}`,
      });
    } finally {
      setLoading(false);
    }
  }, [treasury, account, campaigns]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function run(
    label: string,
    action: () => Promise<{ wait: () => Promise<unknown> }>
  ) {
    setBusy(true);
    setMessage(null);
    try {
      const transaction = await action();
      await transaction.wait();
      setMessage({ ok: true, text: `${label} confirmée.` });
      if (label === "Soumission") setAmount("");
      await load();
      onDone?.();
    } catch (error) {
      setMessage({ ok: false, text: `${label} échouée : ${readError(error)}` });
    } finally {
      setBusy(false);
    }
  }

  async function submitWithdrawal() {
    const campaignId = Number(selectedCampaign);
    const campaign = fundedCampaigns.find((item) => item.id === campaignId);
    if (!campaign) {
      setMessage({ ok: false, text: "Sélectionne une campagne financée." });
      return;
    }

    let value: bigint;
    try {
      value = parseEther(amount);
    } catch {
      setMessage({ ok: false, text: "Montant ETH invalide." });
      return;
    }
    if (value <= 0n || value > campaign.balance) {
      setMessage({
        ok: false,
        text: "Le montant doit être positif et inférieur ou égal au solde de la campagne.",
      });
      return;
    }

    await run("Soumission", () =>
      treasury.submitCampaignWithdrawal(campaignId, campaign.beneficiary, value)
    );
  }

  return (
    <section className="treasury-section section-container">
      <div className="section-heading">
        <div>
          <p className="tagline">TRÉSORERIE MULTISIG</p>
          <h2>Retraits des fonds</h2>
          <p className="section-description">
            Les retraits supérieurs au seuil de {formatEther(threshold)} ETH
            nécessitent deux approbations sur trois.
          </p>
        </div>
        <button className="refresh-button" onClick={() => void load()} disabled={loading || busy}>
          {loading ? "Actualisation..." : "Actualiser"}
        </button>
      </div>

      <div className="treasury-summary">
        <p>
          Votre compte : <strong>{short(account)}</strong>
          {" · "}
          {isOwner ? "Propriétaire multisig" : "Lecture seule — compte non propriétaire"}
        </p>
        {paused && (
          <p className="treasury-warning">
            La trésorerie est en pause : l’exécution des retraits est désactivée.
          </p>
        )}
      </div>

      {isOwner && (
        <div className="treasury-submit">
          <h3>Soumettre un retrait</h3>
          <p className="section-description">
            Le bénéficiaire est automatiquement celui enregistré pour la campagne.
          </p>
          <div className="gov-form">
            <select
              aria-label="Campagne à retirer"
              value={selectedCampaign}
              onChange={(event) => setSelectedCampaign(event.target.value)}
              disabled={
                busy ||
                fundedCampaigns.length === 0 ||
                fundedCampaigns.find(
                  (campaign) => String(campaign.id) === selectedCampaign
                )?.creator.toLowerCase() === account.toLowerCase()
              }
            >
              {fundedCampaigns.length === 0 && (
                <option value="">Aucune campagne avec des fonds en trésorerie</option>
              )}
              {fundedCampaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaignMetadata[
                    campaigns.find((item) => item.id === campaign.id)
                      ?.ipfsHash ?? ""
                  ]?.title ??
                    `Campagne #${campaign.id}`}
                  {" — "}
                  {formatEther(campaign.balance)} ETH disponibles
                  {campaign.creator.toLowerCase() === account.toLowerCase()
                    ? " — Vous êtes le créateur (retrait interdit)"
                    : ""}
                </option>
              ))}
            </select>
            <input
              aria-label="Montant du retrait en ETH"
              type="number"
              min="0"
              step="any"
              placeholder="Montant en ETH"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              disabled={
                busy ||
                fundedCampaigns.length === 0 ||
                fundedCampaigns.find(
                  (campaign) => String(campaign.id) === selectedCampaign
                )?.creator.toLowerCase() === account.toLowerCase()
              }
            />
            <button
              className="action-button"
              onClick={() => void submitWithdrawal()}
              disabled={
                busy ||
                !isOwner ||
                !selectedCampaign ||
                !amount ||
                fundedCampaigns.find(
                  (campaign) => String(campaign.id) === selectedCampaign
                )?.creator.toLowerCase() === account.toLowerCase()
              }
            >
              Soumettre le retrait
            </button>
            {fundedCampaigns.find(
              (campaign) => String(campaign.id) === selectedCampaign
            )?.creator.toLowerCase() === account.toLowerCase() && (
              <p className="action-hint">
                Vous avez créé cette campagne : vous ne pouvez pas soumettre ou signer
                son retrait.
              </p>
            )}
          </div>
        </div>
      )}

      {message && (
        <p className={message.ok ? "action-message ok" : "action-message ko"}>
          {message.text}
        </p>
      )}

      {transactions.length === 0 ? (
        <div className="empty-state">
          <h3>Aucun retrait soumis</h3>
          <p>Les demandes multisignature apparaîtront ici.</p>
        </div>
      ) : (
        <div className="treasury-list">
          {transactions.map((transaction) => {
            const campaign = campaigns.find(
              (item) => item.id === transaction.campaignId
            );
            const canApprove =
              isOwner &&
              !transaction.isCampaignCreator &&
              !transaction.executed &&
              !transaction.approvedByMe;
            const canExecute =
              isOwner &&
              !transaction.isCampaignCreator &&
              !paused &&
              !transaction.executed &&
              transaction.approvals >= transaction.requiredApprovals;

            return (
              <article className="treasury-transaction" key={transaction.id}>
                <div className="treasury-transaction-heading">
                  <h3>
                    Retrait #{transaction.id} ·{" "}
                    {campaign
                      ? campaignMetadata[campaign.ipfsHash]?.title ??
                        `Campagne #${transaction.campaignId}`
                      : `Campagne #${transaction.campaignId}`}
                  </h3>
                  <span className={transaction.executed ? "status status-1" : "status status-0"}>
                    {transaction.executed ? "Exécuté" : "En attente"}
                  </span>
                </div>
                <div className="treasury-transaction-details">
                  <p>
                    <span>Montant</span>
                    <strong>{formatEther(transaction.amount)} ETH</strong>
                  </p>
                  <p>
                    <span>Bénéficiaire</span>
                    <strong>{short(transaction.recipient)}</strong>
                  </p>
                  <p>
                    <span>Approbations</span>
                    <strong>
                      {transaction.approvals.toString()} /{" "}
                      {transaction.requiredApprovals.toString()}
                    </strong>
                  </p>
                  <p>
                    <span>Votre approbation</span>
                    <strong>{transaction.approvedByMe ? "Oui" : "Non"}</strong>
                  </p>
                </div>
                {transaction.isCampaignCreator && !transaction.executed && (
                  <p className="action-hint">
                    Vous avez créé cette campagne : vous ne pouvez pas approuver ou
                    exécuter son retrait.
                  </p>
                )}
                {isOwner && !transaction.executed && (
                  <div className="gov-buttons">
                    {canApprove && (
                      <button
                        className="action-button"
                        disabled={busy}
                        onClick={() =>
                          void run("Approbation", () =>
                            treasury.approveTransaction(transaction.id)
                          )
                        }
                      >
                        Approuver
                      </button>
                    )}
                    {canExecute && (
                      <button
                        className="action-button"
                        disabled={busy}
                        onClick={() =>
                          void run("Exécution", () =>
                            treasury.executeTransaction(transaction.id)
                          )
                        }
                      >
                        Exécuter le retrait
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
