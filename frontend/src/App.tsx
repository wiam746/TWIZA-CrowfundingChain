
import { useEffect, useState } from "react";
import { BrowserProvider, formatEther, parseEther } from "ethers";
import {
  connectWallet,
  CONTRACT_ADDRESSES,
  NETWORK_CONFIG,
} from "./blockchain";
import CampaignActions from "./CampaignActions";
import EmergencyControls from "./EmergencyControls";
import GovernancePanel from "./GovernancePanel";
import TreasuryPanel from "./TreasuryPanel";
import {
  fetchCampaignMetadata,
  uploadCampaignMetadata,
  type CampaignMetadata,
} from "./ipfs";
import "./App.css";

type ContractSet = Awaited<ReturnType<typeof connectWallet>>["contracts"];

interface Campaign {
  id: number;
  creator: string;
  beneficiary: string;
  goal: bigint;
  raised: bigint;
  deadline: number;
  status: number;
  paused: boolean;
  frozen: boolean;
  withdrawalApproved: boolean;
  withdrawn: boolean;
  ipfsHash: string;
}

const STATUS: Record<number, string> = {
  0: "En cours",
  1: "Réussie",
  2: "Échouée",
  3: "Annulée",
};

function formatETH(value: bigint) {
  return Number(formatEther(value)).toLocaleString("fr-FR", {
    maximumFractionDigits: 4,
  });
}

function shortAddress(address: string) {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function App() {
  const [theme, setTheme] = useState<"dark" | "light">(
    () => localStorage.getItem("cfdchain-theme") === "light" ? "light" : "dark"
  );
  const [account, setAccount] = useState("");
  const [balance, setBalance] = useState("0");
  const [contracts, setContracts] = useState<ContractSet | null>(null);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignMetadata, setCampaignMetadata] = useState<
    Record<string, CampaignMetadata>
  >({});
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [goal, setGoal] = useState("");
  const [duration, setDuration] = useState("30");
  const [beneficiary, setBeneficiary] = useState("");
  const [campaignTitle, setCampaignTitle] = useState("");
  const [campaignDescription, setCampaignDescription] = useState("");
  const [pinataJwt, setPinataJwt] = useState("");

  async function loadCampaigns(contractSet: ContractSet) {
    setLoading(true);

    try {
      const crowdfunding = contractSet.Crowdfunding;

      const count = await crowdfunding
        .getFunction("campaignCount")();

      const total = Number(count);
      const paused = await crowdfunding.getFunction("paused")() as boolean;
      const results: Campaign[] = [];

      for (let id = 1; id <= total; id++) {
        const c = await crowdfunding
          .getFunction("getCampaign")(id);

        results.push({
          id: Number(c.id),
          creator: c.creator,
          beneficiary: c.beneficiary,
          goal: BigInt(c.goal),
          raised: BigInt(c.raised),
          deadline: Number(c.deadline),
          status: Number(c.status),
          paused,
          frozen: c.frozen,
          withdrawalApproved: c.withdrawalApproved,
          withdrawn: c.withdrawn,
          ipfsHash: c.ipfsHash,
        });
      }

      setCampaigns(results.reverse());
      const metadataResults = await Promise.allSettled(
        results.map(async (campaign) => ({
          cid: campaign.ipfsHash,
          metadata: await fetchCampaignMetadata(campaign.ipfsHash),
        }))
      );
      const loadedMetadata: Record<string, CampaignMetadata> = {};
      metadataResults.forEach((result, index) => {
        if (result.status === "fulfilled") {
          loadedMetadata[result.value.cid] = result.value.metadata;
        } else {
          console.warn(
            `Impossible de charger les métadonnées IPFS de la campagne ${results[index].id}:`,
            result.reason
          );
        }
      });
      setCampaignMetadata(loadedMetadata);
    } catch (err) {
      console.error(err);
      setError("Impossible de charger les campagnes.");
    } finally {
      setLoading(false);
    }
  }

  // Recharge le solde ETH du compte connecté (sans redemander la connexion à MetaMask).
  async function refreshBalance() {
    if (!window.ethereum || !account) return;
    const provider = new BrowserProvider(window.ethereum);
    setBalance(formatETH(await provider.getBalance(account)));
  }

  // Recharge tout après une transaction (campagnes + solde).
  async function reloadAll() {
    if (contracts) await loadCampaigns(contracts);
    await refreshBalance();
  }

  async function handleConnect() {
    try {
      setError("");
      setSuccess("");
      setLoading(true);

      const result = await connectWallet();

      const walletBalance = await result.provider.getBalance(
        result.address
      );

      setAccount(result.address);
      setBalance(formatETH(walletBalance));
      setBeneficiary(result.address);
      setContracts(result.contracts);

      await loadCampaigns(result.contracts);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Erreur de connexion.";

      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateCampaign(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (!contracts) {
      setError("Connecte d'abord ton portefeuille.");
      return;
    }

    try {
      setCreating(true);
      setError("");
      setSuccess("");

      if (!goal || Number(goal) <= 0) {
        throw new Error("L'objectif doit être supérieur à zéro.");
      }

      if (!duration || Number(duration) <= 0) {
        throw new Error("La durée doit être supérieure à zéro.");
      }

      if (!/^0x[a-fA-F0-9]{40}$/.test(beneficiary)) {
        throw new Error("Adresse du bénéficiaire invalide.");
      }

      if (!campaignTitle.trim()) {
        throw new Error("Le titre du projet est obligatoire.");
      }

      if (!campaignDescription.trim()) {
        throw new Error("La description du projet est obligatoire.");
      }

      if (!pinataJwt.trim()) {
        throw new Error("Le JWT Pinata est obligatoire pour l'upload.");
      }

      const goalWei = parseEther(goal);
      const durationSeconds = BigInt(duration) * 86400n;
      setSuccess("Envoi des métadonnées sur IPFS via Pinata...");
      const cid = await uploadCampaignMetadata(
        {
          title: campaignTitle.trim(),
          description: campaignDescription.trim(),
        },
        pinataJwt.trim()
      );

      const tx = await contracts.Crowdfunding
        .getFunction("createCampaign")(
          goalWei,
          durationSeconds,
          beneficiary,
          cid
        );

      setSuccess(
        `Métadonnées envoyées (CID ${cid}). Transaction en attente de confirmation...`
      );

      await tx.wait();

      setSuccess("Campagne créée avec succès !");
      setGoal("");
      setDuration("30");
      setCampaignTitle("");
      setCampaignDescription("");
      setPinataJwt("");

      await refreshBalance();

      await loadCampaigns(contracts);
    } catch (err) {
      console.error(err);

      const message =
        err instanceof Error
          ? err.message
          : "Erreur lors de la création.";
      setSuccess("");

      setError(
        message.includes("NO_SCOPES_FOUND")
          ? "Pinata a refusé le JWT : aucune permission d'upload n'est associée à ce token. Crée un nouveau JWT/API key avec le droit d'épingler du JSON (pinning write), puis réessaie. Ne partage pas ton JWT."
          : message.includes("user rejected")
            ? "Transaction refusée dans MetaMask."
            : message
      );
    } finally {
      setCreating(false);
    }
  }

  // Changement de compte ou de réseau dans MetaMask : on recharge la page pour repartir d'un état propre.
  useEffect(() => {
    const eth = window.ethereum as unknown as
      | {
          on?: (event: string, callback: () => void) => void;
          removeListener?: (event: string, callback: () => void) => void;
        }
      | undefined;
    if (!eth?.on) return;

    const reload = () => window.location.reload();
    eth.on("accountsChanged", reload);
    eth.on("chainChanged", reload);

    return () => {
      eth.removeListener?.("accountsChanged", reload);
      eth.removeListener?.("chainChanged", reload);
    };
  }, []);

  const totalRaised = campaigns.reduce(
    (total, campaign) => total + campaign.raised,
    0n
  );

  useEffect(() => {
    localStorage.setItem("cfdchain-theme", theme);
  }, [theme]);

  return (
    <div className="app" data-theme={theme}>
      <header className="navbar">
        <h2>CFD<span>Chain</span></h2>

        <div className="navbar-actions">
          <button
            className="theme-toggle"
            type="button"
            onClick={() =>
              setTheme((current) => current === "dark" ? "light" : "dark")
            }
            aria-label={`Activer le mode ${theme === "dark" ? "clair" : "sombre"}`}
            aria-pressed={theme === "light"}
          >
            {theme === "dark" ? "☀️ Mode clair" : "🌙 Mode sombre"}
          </button>

          {account && (
            <span className="network-label">
              {NETWORK_CONFIG.name}
            </span>
          )}

          <button
            className="connect-button"
            onClick={handleConnect}
            disabled={loading || creating}
          >
            {loading
              ? "Chargement..."
              : account
                ? "Portefeuille connecté"
                : "Connecter MetaMask"}
          </button>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-content">
            <p className="tagline">
              DECENTRALIZED CROWDFUNDING
            </p>

            <h1>
              Financez les idées.
              <br />
              <span>Construisez l'avenir.</span>
            </h1>

            <p className="description">
              Une plateforme décentralisée permettant de créer
              des campagnes, de contribuer à des projets et de
              participer à leur gouvernance grâce à la blockchain.
            </p>

            {account ? (
              <div className="wallet-card">
                <div>
                  <p>Portefeuille connecté</p>
                  <strong>{shortAddress(account)}</strong>
                </div>

                <div>
                  <p>Solde disponible</p>
                  <strong>{balance} ETH</strong>
                </div>
              </div>
            ) : (
              <button
                className="main-button"
                onClick={handleConnect}
                disabled={loading}
              >
                Commencer
              </button>
            )}
          </div>
        </section>

        {error && (
          <div className="message error">{error}</div>
        )}

        {success && (
          <div className="message success">{success}</div>
        )}

        {account && (
          <>
            <section className="dashboard section-container">
              <div className="section-heading">
                <div>
                  <p className="tagline">TABLEAU DE BORD</p>
                  <h2>Vue d'ensemble</h2>
                </div>
              </div>

              <div className="stats-grid">
                <div className="stat-card">
                  <p>Nombre de campagnes</p>
                  <h3>{campaigns.length}</h3>
                </div>

                <div className="stat-card">
                  <p>Total collecté</p>
                  <h3>{formatETH(totalRaised)} ETH</h3>
                </div>

                <div className="stat-card">
                  <p>Mon portefeuille</p>
                  <h3>{balance} ETH</h3>
                </div>
              </div>
            </section>

            <section className="create-section section-container">
              <div className="section-heading">
                <div>
                  <p className="tagline">LANCER UN PROJET</p>
                  <h2>Créer une campagne</h2>
                  <p className="section-description">
                    Définissez votre objectif et les paramètres
                    de votre campagne.
                  </p>
                </div>
              </div>

              <form
                className="campaign-form"
                onSubmit={handleCreateCampaign}
              >
                <div className="form-group">
                  <label>Objectif financier (ETH)</label>
                  <input
                    type="number"
                    min="0.000000000000000001"
                    step="any"
                    placeholder="Ex : 5"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Durée (jours)</label>
                  <input
                    type="number"
                    min="1"
                    placeholder="30"
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group full-width">
                  <label htmlFor="campaign-title">Titre du projet</label>
                  <input
                    id="campaign-title"
                    type="text"
                    maxLength={120}
                    placeholder="Ex : Construire un puits communautaire"
                    value={campaignTitle}
                    onChange={(e) => setCampaignTitle(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group full-width">
                  <label htmlFor="campaign-description">Description</label>
                  <textarea
                    id="campaign-description"
                    rows={5}
                    maxLength={5000}
                    placeholder="Présentez le projet et l'utilisation des fonds..."
                    value={campaignDescription}
                    onChange={(e) => setCampaignDescription(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group full-width">
                  <label>Adresse du bénéficiaire</label>
                  <input
                    type="text"
                    placeholder="0x..."
                    value={beneficiary}
                    onChange={(e) => setBeneficiary(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group full-width">
                  <label htmlFor="pinata-jwt">JWT Pinata</label>
                  <input
                    id="pinata-jwt"
                    type="password"
                    autoComplete="off"
                    placeholder="Collez votre JWT Pinata (non conservé)"
                    value={pinataJwt}
                    onChange={(e) => setPinataJwt(e.target.value)}
                    required
                  />
                  <small className="form-help">
                    Utilisé uniquement dans cette session pour envoyer les
                    métadonnées sur Pinata ; il n'est pas enregistré.
                  </small>
                </div>

                <button
                  className="submit-button full-width"
                  type="submit"
                  disabled={creating}
                >
                  {creating
                    ? "Upload / transaction en cours..."
                    : "Créer la campagne"}
                </button>
              </form>
            </section>

            <section className="campaigns-section section-container">
              <div className="section-heading">
                <div>
                  <p className="tagline">DÉCOUVRIR</p>
                  <h2>Campagnes disponibles</h2>
                  <p className="section-description">
                    Consultez les projets enregistrés sur la blockchain.
                  </p>
                </div>

                <button
                  className="refresh-button"
                  onClick={() => contracts && loadCampaigns(contracts)}
                  disabled={loading}
                >
                  {loading ? "Actualisation..." : "Actualiser"}
                </button>
              </div>

              {campaigns.length === 0 && !loading ? (
                <div className="empty-state">
                  <h3>Aucune campagne pour le moment</h3>
                  <p>
                    Soyez le premier à lancer un projet sur TWIZA.
                  </p>
                </div>
              ) : (
                <div className="campaign-grid">
                  {campaigns.map((campaign) => {
                    const goalETH = Number(formatEther(campaign.goal));
                    const raisedETH = Number(formatEther(campaign.raised));

                    const progress =
                      goalETH > 0
                        ? Math.min((raisedETH / goalETH) * 100, 100)
                        : 0;

                    return (
                      <article
                        className="campaign-card"
                        key={campaign.id}
                      >
                        <div className="campaign-card-top">
                          <span className="campaign-id">
                            CAMPAGNE #{campaign.id}
                          </span>

                          <span className={`status status-${campaign.status}`}>
                            {STATUS[campaign.status] ?? "Inconnu"}
                          </span>
                        </div>

                        <h3>
                          {campaignMetadata[campaign.ipfsHash]?.title ??
                            `Projet #${campaign.id}`}
                        </h3>

                        {campaignMetadata[campaign.ipfsHash] && (
                          <p className="campaign-description">
                            {campaignMetadata[campaign.ipfsHash].description}
                          </p>
                        )}

                        <p className="ipfs-reference">
                          IPFS :{" "}
                          <a
                            href={`https://gateway.pinata.cloud/ipfs/${encodeURIComponent(campaign.ipfsHash)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {campaign.ipfsHash}
                          </a>
                        </p>

                        <div className="campaign-amounts">
                          <div>
                            <strong>{formatETH(campaign.raised)} ETH</strong>
                            <span>Collectés</span>
                          </div>

                          <div>
                            <strong>{formatETH(campaign.goal)} ETH</strong>
                            <span>Objectif</span>
                          </div>
                        </div>

                        <div className="progress-track">
                          <div
                            className="progress-fill"
                            style={{ width: `${progress}%` }}
                          />
                        </div>

                        <p className="progress-label">
                          {progress.toFixed(1)} % de l'objectif
                        </p>

                        <div className="campaign-details">
                          <p>
                            <span>Bénéficiaire</span>
                            <strong>
                              {shortAddress(campaign.beneficiary)}
                            </strong>
                          </p>

                          <p>
                            <span>Date limite</span>
                            <strong>
                              {new Date(
                                campaign.deadline * 1000
                              ).toLocaleDateString("fr-FR")}
                            </strong>
                          </p>

                          <p>
                            <span>Approbation DAO</span>
                            <strong>
                              {campaign.withdrawalApproved
                                ? "Approuvée"
                                : "En attente"}
                            </strong>
                          </p>

                          <p>
                            <span>Retrait</span>
                            <strong>
                              {campaign.withdrawn
                                ? "Effectué"
                                : "Non effectué"}
                            </strong>
                          </p>
                        </div>

                        <CampaignActions
                          key={`${campaign.id}-${campaign.status}-${campaign.raised}-${campaign.paused}-${campaign.frozen}-${campaign.withdrawalApproved}-${campaign.withdrawn}`}
                          campaignId={campaign.id}
                          account={account}
                          crowdfundingAddress={CONTRACT_ADDRESSES.Crowdfunding}
                          tokenAddress={CONTRACT_ADDRESSES.CFDToken}
                          onDone={() => void reloadAll()}
                        />
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            {contracts && (
              <GovernancePanel
                governance={contracts.Governance}
                token={contracts.CFDToken}
                account={account}
                campaigns={campaigns}
                onDone={() => void reloadAll()}
              />
            )}

            {contracts && (
              <TreasuryPanel
                treasury={contracts.Treasury}
                account={account}
                campaigns={campaigns}
                campaignMetadata={campaignMetadata}
                onDone={() => void reloadAll()}
              />
            )}

            {contracts && (
              <EmergencyControls
                crowdfunding={contracts.Crowdfunding}
                treasury={contracts.Treasury}
                account={account}
                onDone={() => void reloadAll()}
              />
            )}
          </>
        )}
      </main>

      <footer>
        TWIZA — Powered by Ethereum Blockchain
      </footer>
    </div>
  );
}

export default App;
