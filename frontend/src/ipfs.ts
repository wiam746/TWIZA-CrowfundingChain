export interface CampaignMetadata {
  title: string;
  description: string;
}

interface PinataUploadResponse {
  IpfsHash?: unknown;
  error?: {
    reason?: string;
    details?: string;
  };
}

export async function uploadCampaignMetadata(
  metadata: CampaignMetadata,
  jwt: string
): Promise<string> {
  const response = await fetch(
    "https://api.pinata.cloud/pinning/pinJSONToIPFS",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pinataContent: metadata,
        pinataMetadata: { name: metadata.title },
      }),
    }
  );

  const result = (await response.json()) as PinataUploadResponse;
  if (!response.ok) {
    throw new Error(
      result.error?.reason ??
        result.error?.details ??
        `Échec de l'envoi Pinata (HTTP ${response.status}).`
    );
  }

  if (typeof result.IpfsHash !== "string" || !result.IpfsHash.trim()) {
    throw new Error("Pinata n'a pas renvoyé de CID valide.");
  }

  return result.IpfsHash;
}

export async function fetchCampaignMetadata(
  cid: string
): Promise<CampaignMetadata> {
  const response = await fetch(
    `https://gateway.pinata.cloud/ipfs/${encodeURIComponent(cid)}`
  );
  if (!response.ok) {
    throw new Error(
      `Impossible de lire les métadonnées IPFS (HTTP ${response.status}).`
    );
  }

  const metadata: unknown = await response.json();
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("title" in metadata) ||
    typeof metadata.title !== "string" ||
    !("description" in metadata) ||
    typeof metadata.description !== "string"
  ) {
    throw new Error("Les métadonnées IPFS n'ont pas le format attendu.");
  }

  return {
    title: metadata.title,
    description: metadata.description,
  };
}
