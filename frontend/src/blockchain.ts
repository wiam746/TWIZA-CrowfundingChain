
import { BrowserProvider, Contract, getAddress } from "ethers";

import CFDTokenABI from "./abi/CFDToken.json";
import CrowdfundingABI from "./abi/Crowdfunding.json";
import GovernanceABI from "./abi/Governance.json";
import TreasuryABI from "./abi/Treasury.json";

type NetworkMode = "local" | "sepolia";

const networkMode = (import.meta.env.VITE_NETWORK ?? "local").toLowerCase();
if (networkMode !== "local" && networkMode !== "sepolia") {
  throw new Error('VITE_NETWORK doit valoir "local" ou "sepolia".');
}

export const NETWORK_MODE = networkMode as NetworkMode;

const LOCAL_NETWORK = {
  chainId: 31337n,
  chainIdHex: "0x7a69",
  name: "Hardhat Localhost",
  rpcUrl: "http://127.0.0.1:8545",
};

const SEPOLIA_NETWORK = {
  chainId: 11155111n,
  chainIdHex: "0xaa36a7",
  name: "Sepolia",
  rpcUrl: import.meta.env.VITE_SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org",
  blockExplorerUrl: "https://sepolia.etherscan.io",
};

export const NETWORK_CONFIG =
  NETWORK_MODE === "sepolia" ? SEPOLIA_NETWORK : LOCAL_NETWORK;

function contractAddress(name: string, value: string | undefined, local: string) {
  const address = value ?? (NETWORK_MODE === "local" ? local : undefined);
  if (!address) {
    throw new Error(
      `Adresse ${name} manquante. Configure VITE_${name.toUpperCase()}_ADDRESS dans frontend/.env.local.`
    );
  }
  try {
    return getAddress(address);
  } catch {
    throw new Error(`Adresse de contrat ${name} invalide.`);
  }
}

export const CONTRACT_ADDRESSES = {
  CFDToken: contractAddress(
    "CFD_TOKEN",
    import.meta.env.VITE_CFD_TOKEN_ADDRESS,
    "0x5FbDB2315678afecb367f032d93F642f64180aa3"
  ),
  Treasury: contractAddress(
    "TREASURY",
    import.meta.env.VITE_TREASURY_ADDRESS,
    "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
  ),
  Crowdfunding: contractAddress(
    "CROWDFUNDING",
    import.meta.env.VITE_CROWDFUNDING_ADDRESS,
    "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"
  ),
  Governance: contractAddress(
    "GOVERNANCE",
    import.meta.env.VITE_GOVERNANCE_ADDRESS,
    "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9"
  ),
};

declare global {
  interface Window {
    ethereum?: {
      request: (args: {
        method: string;
        params?: unknown[];
      }) => Promise<unknown>;
    };
  }
}

// Connexion à MetaMask et au réseau configuré (local par défaut ou Sepolia).
export async function connectWallet() {
  if (!window.ethereum) {
    throw new Error("MetaMask n'est pas installé.");
  }

  // Demander l'accès au portefeuille
  await window.ethereum.request({
    method: "eth_requestAccounts",
  });

  // Vérifier le réseau
  const chainId = await window.ethereum.request({
    method: "eth_chainId",
  });

  if (
    typeof chainId !== "string" ||
    chainId.toLowerCase() !== NETWORK_CONFIG.chainIdHex
  ) {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: NETWORK_CONFIG.chainIdHex }],
      });
    } catch (error) {
      const walletError = error as { code?: number };

      if (walletError.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: NETWORK_CONFIG.chainIdHex,
              chainName: NETWORK_CONFIG.name,
              nativeCurrency: {
                name: "Ether",
                symbol: "ETH",
                decimals: 18,
              },
              rpcUrls: [NETWORK_CONFIG.rpcUrl],
              ...(NETWORK_MODE === "sepolia"
                ? {
                    blockExplorerUrls: [
                      SEPOLIA_NETWORK.blockExplorerUrl,
                    ],
                  }
                : {}),
            },
          ],
        });
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: NETWORK_CONFIG.chainIdHex }],
        });
      } else {
        throw error;
      }
    }
  }

  // Initialiser Ethers.js
  const provider = new BrowserProvider(window.ethereum);
  const actualNetwork = await provider.getNetwork();
  if (actualNetwork.chainId !== NETWORK_CONFIG.chainId) {
    throw new Error(
      `Réseau incorrect : sélectionne ${NETWORK_CONFIG.name} dans MetaMask.`
    );
  }
  const signer = await provider.getSigner();

  const address = await signer.getAddress();

  // Initialiser les quatre contrats
  const contracts = {
    CFDToken: new Contract(
      CONTRACT_ADDRESSES.CFDToken,
      CFDTokenABI,
      signer
    ),

    Crowdfunding: new Contract(
      CONTRACT_ADDRESSES.Crowdfunding,
      CrowdfundingABI,
      signer
    ),

    Governance: new Contract(
      CONTRACT_ADDRESSES.Governance,
      GovernanceABI,
      signer
    ),

    Treasury: new Contract(
      CONTRACT_ADDRESSES.Treasury,
      TreasuryABI,
      signer
    ),
  };

  return {
    provider,
    signer,
    address,
    contracts,
  };
}
