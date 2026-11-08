Co-authored-by: agourramhajar & Sabah-123
# TWIZA — plateforme de financement participatif décentralisée à gouvernance par jeton

Mini-projet du module **Blockchain** — ENSA Béni Mellal, filière Intelligence Artificielle et Cybersécurité.

Les porteurs de projet créent des campagnes ; les contributeurs financent en ETH et reçoivent des jetons de gouvernance **CFD** (ERC-20). Les décisions sensibles (déblocage des fonds, gel d'une campagne suspecte) sont votées par les détenteurs de CFD, et les fonds débloqués transitent par une trésorerie protégée par multisignature 2-sur-3.

## Architecture

| Module | Contrat | Rôle |
|---|---|---|
| M1 Jeton | `contracts/CFDToken.sol` | ERC-20 + `ERC20Votes` (historique des soldes = snapshot) + `ERC20Permit`. Seul `Crowdfunding` peut frapper (`MINTER_ROLE`). |
| M2 Cœur | `contracts/Crowdfunding.sol` | Campagnes, contributions (100 CFD par ETH), statuts, `refund`, `withdrawFunds` conditionné à la DAO. |
| M3 DAO | `contracts/Governance.sol` | Propositions « approuver le retrait » ou « geler la campagne », vote pondéré **sur snapshot**, quorum 20 %. |
| Sécurité | `contracts/Treasury.sol` | Reçoit les fonds des campagnes réussies ; retrait au-delà de 1 ETH = 2 signatures sur 3. |
| M4 dApp | `frontend/` | React + Vite + Ethers.js + MetaMask : campagnes, contribution, tableau de vote et retraits multisig. |

Flux : `createCampaign` → `contribute` (mint de CFD) → objectif atteint → proposition DAO → vote → `executeProposal` → `approveWithdrawal` → le bénéficiaire appelle `withdrawFunds` (fonds vers la trésorerie) → retrait multisig.

Le panneau « Trésorerie multisig » du frontend liste les fonds disponibles par campagne et les demandes de retrait. Les propriétaires peuvent soumettre une demande, approuver celles des autres propriétaires et exécuter une transaction une fois le seuil d'approbations atteint. Le créateur d'une campagne ne peut ni proposer ni voter l'approbation DAO du retrait de sa campagne ; s'il est aussi propriétaire Treasury, il ne peut pas soumettre, approuver ou exécuter son retrait. Si le cumul des demandes dépasse le seuil, toutes les demandes encore en attente de cette campagne requièrent deux approbations. Après l'approbation DAO, seul le bénéficiaire connecté voit le bouton de transfert des fonds vers la trésorerie. Le panneau « Circuit breaker » affiche les boutons de pause/reprise séparément pour Crowdfunding et Treasury uniquement aux comptes qui possèdent le `PAUSER_ROLE` correspondant.

## Paramètres et justifications

- **Taux : 1 ETH = 100 CFD** (`CFD_PER_ETH`). Entier, sans erreur d'arrondi, proportionnel à l'apport.
- **Quorum : 20 %** de l'offre de CFD au snapshot ; son seuil est mémorisé à la création de la proposition, sans appel externe dans le parcours du keeper. **Majorité** : strictement plus de « pour » que de « contre ».
- **Snapshot** : le pouvoir de vote est lu au bloc précédant la création de la proposition (`getPastVotes`).
- **Vote** : 20 blocs, avec un délai d'un bloc avant l'ouverture (valeurs courtes pour la démonstration).
- **Multisig** : 3 propriétaires, 2 approbations requises au-delà de 1 ETH.

## Sécurité implémentée

| Exigence | Mesure |
|---|---|
| Anti-reentrance | Checks-Effects-Interactions + `ReentrancyGuard` sur `contribute`, `refund`, `withdrawFunds`, `executeTransaction`, `executeProposal`. |
| Contrôle d'accès | `AccessControl` : `MINTER_ROLE`, `GOVERNANCE_ROLE`, `CROWDFUNDING_ROLE`, `PAUSER_ROLE`. |
| Circuit breaker | `Pausable` sur Crowdfunding et Treasury, réservé à `PAUSER_ROLE`. |
| Multisignature | `Treasury` : 2 signatures sur 3 au-delà du seuil. |
| Anti-manipulation | Snapshot via `ERC20Votes` : des CFD obtenus après la création d'une proposition n'ont aucun poids. |
| Séparation des pouvoirs | `deploy.ts` retire `DEFAULT_ADMIN_ROLE` à l'administrateur sur les trois contrats : il ne peut plus s'attribuer `MINTER_ROLE` ni `GOVERNANCE_ROLE`. Il garde seulement la pause. |

## Prérequis et installation

Node.js 22 ou plus récent, MetaMask.

```bash
npm install
cd frontend && npm install && cd ..
```

## Tests

```bash
npx hardhat test                  # toute la suite
npx hardhat test test/Security.ts # sécurité : reentrance, snapshot, accès, pause, gel
npx hardhat test test/Fuzz.ts     # fuzzing à invariants (graine reproductible)
```

Fichiers : `CFDToken.ts`, `Crowdfunding.ts`, `Governance.ts`, `Treasury.ts`, `Integration.ts` (parcours complet), `Security.ts`, `Fuzz.ts`. Le contrat `contracts/mocks/ReentrancyMocks.sol` sert uniquement aux tests : **ne jamais le déployer**.

Rejouer le fuzzing avec d'autres paramètres (Windows) : `set FUZZ_SEED=123 && set FUZZ_RUNS=500 && npx hardhat test test/Fuzz.ts`.

## Démonstration locale

Quatre terminaux :

```bash
# Terminal 1 : blockchain locale
npx hardhat node

# Terminal 2 : déploiement et vérification des rôles
npx hardhat run scripts/deploy.ts --network localhost
npx hardhat run scripts/check-roles.ts --network localhost

# Terminal 3 : keeper d'exécution des propositions approuvées
npx hardhat run scripts/keeper.ts --network localhost

# Terminal 4 : interface
cd frontend
npm run dev        # http://localhost:5173
```

Le keeper vérifie `checkUpkeep` toutes les 5 secondes et appelle `performUpkeep` lorsqu'une proposition approuvée peut être exécutée. Il utilise par défaut l'adresse Governance du déploiement local standard ; pour une autre adresse, définir `GOVERNANCE_ADDRESS`. L'intervalle peut être modifié avec `KEEPER_POLL_INTERVAL_MS`.

Dans MetaMask : réseau « Hardhat Localhost » (RPC `http://127.0.0.1:8545`, chainId 31337), puis importer les comptes de test affichés par `hardhat node`. Après chaque redémarrage du nœud, effacer les données d'activité du compte (Paramètres → Avancé).

Parcours des fonds : après approbation par la DAO, reconnecter MetaMask avec le compte bénéficiaire puis cliquer « Retirer les fonds vers la trésorerie » sur la carte de campagne. Les propriétaires multisig soumettent ensuite la demande, la font approuver par un second propriétaire si nécessaire, puis exécutent le retrait depuis le panneau Trésorerie. Les comptes portant `PAUSER_ROLE` peuvent suspendre ou reprendre séparément Crowdfunding et Treasury dans le panneau Circuit breaker.

Les adresses de `frontend/src/blockchain.ts` correspondent à un déploiement sur un nœud neuf. Les ABI sont dans `frontend/src/abi/` ; pour les régénérer après une modification d'un contrat :

```bash
cd frontend
node --input-type=module -e "import fs from 'node:fs'; for (const n of ['CFDToken','Crowdfunding','Governance','Treasury']) { const a=JSON.parse(fs.readFileSync('../artifacts/contracts/'+n+'.sol/'+n+'.json','utf8')); fs.writeFileSync('src/abi/'+n+'.json',JSON.stringify(a.abi,null,2)); }"
```

## Déploiement sur Sepolia

1. Créer un endpoint RPC Sepolia et approvisionner le compte de déploiement avec de l'ETH de test. Pour ce déploiement académique, viser environ `0.02 ETH` donne une marge par rapport aux frais variables ; ce montant n'est pas garanti suffisant si le prix du gas augmente. `0.005 ETH` peut suffire, mais offre moins de marge.
2. Créer `frontend/.env.local` à partir de `frontend/.env.example`. Renseigner les quatre adresses publiques de contrats après déploiement.
3. Enregistrer les secrets Hardhat et déployer. Les trois propriétaires multisig sont des adresses publiques ; seul le compte admin de déploiement signe les transactions :

```bash
npx hardhat keystore set SEPOLIA_RPC_URL
npx hardhat keystore set SEPOLIA_PRIVATE_KEY
OWNER1=0x... OWNER2=0x... OWNER3=0x... THRESHOLD_ETH=0.01 \
  npx hardhat run scripts/deploy.ts --network sepolia
```

Le seuil `THRESHOLD_ETH` est optionnel et vaut `0.01 ETH` par défaut : il reste bas pour pouvoir tester les cas du multisig avec des montants modestes sur Sepolia. Ce seuil est une règle de fonctionnement de Treasury, distincte du solde nécessaire pour payer les frais de déploiement. Vérifier attentivement les trois propriétaires et l'adresse admin : le déploiement retire ensuite `DEFAULT_ADMIN_ROLE`, action irréversible pour ces contrats.

Le RPC réservé au déploiement et la clé privée du compte admin se saisissent dans les invites du keystore Hardhat ; ne les placez pas dans `frontend/.env.local`. Si un RPC de fournisseur contenant une clé d'accès a déjà été copié dans un fichier `VITE_*`, révoquez ou régénérez cette clé dans le tableau de bord du fournisseur.

Dans `frontend/.env.local`, mettre `VITE_NETWORK=sepolia` et définir les valeurs affichées par le déploiement :

```dotenv
VITE_CFD_TOKEN_ADDRESS=0x...
VITE_TREASURY_ADDRESS=0x...
VITE_CROWDFUNDING_ADDRESS=0x...
VITE_GOVERNANCE_ADDRESS=0x...
```

Puis compiler/lancer le frontend :

```bash
cd frontend
npm run build
npm run dev
```

MetaMask demandera le passage sur Sepolia. Les variables `VITE_*` sont publiques dans le bundle frontend : ne jamais y mettre de clé privée. Les propriétaires multisig doivent utiliser leurs propres wallets pour signer les approbations.

Pour revenir en local, régler `VITE_NETWORK=local` (ou supprimer cette variable) ; les adresses Hardhat standard sont alors utilisées :

```bash
npx hardhat run scripts/deploy.ts --network localhost
```

## Métadonnées IPFS

Lors de la création d'une campagne, l'interface envoie le titre et la description en JSON sur Pinata, puis enregistre le CID renvoyé dans `ipfsHash`. Les cartes de campagne récupèrent ces informations depuis la passerelle IPFS Pinata. Le JWT Pinata est saisi dans le formulaire, uniquement gardé en mémoire pendant la session et jamais enregistré dans le dépôt ou le stockage local du navigateur. Comme tout secret utilisé directement par un frontend, il reste visible dans la session du navigateur : pour une application publique en production, préférez un backend qui signe les téléversements ou délivre des autorisations temporaires limitées.

## Analyse des contributions (Python)

Le script en lecture seule `scripts/analyze_contributions.py` interroge un nœud JSON-RPC pour analyser les événements `ContributionReceived`. Sur le nœud local de démonstration (déjà lancé et contrats déployés) :

```bash
/usr/bin/python scripts/analyze_contributions.py
```

Il signale les montants observés au moins trois fois dans une campagne, les contributions dépassant trois fois la médiane de cette campagne et les paires d'adresses qui répètent des montants identiques à proximité dans les blocs. Les deux dernières observations sont des heuristiques, pas des preuves d'abus ou de contrôle commun. Pour utiliser un autre nœud ou contrat, définir `RPC_URL` et `CROWDFUNDING_ADDRESS`. Des seuils alternatifs peuvent être passés avec `--repeat-count`, `--peak-multiple`, `--linked-window` et `--linked-min-matches`.

Tests du parseur et des heuristiques (bibliothèque standard uniquement) :

```bash
/usr/bin/python -m unittest discover -s test -p 'test_analyze_contributions.py'
```

## Audit statique

```bash
pip install slither-analyzer solc-select
solc-select install 0.8.34 && solc-select use 0.8.34
slither . --filter-paths "node_modules|contracts/mocks"
```

Le dernier relevé Slither a rapporté 11 résultats. Le rapport final présente
les corrections, les findings restants et les limites de cette analyse :
[Rapport final d'audit](docs/rapport-audit-avant-apres.md).

Les sorties Slither sont des analyses statiques ; elles ne constituent pas un
audit indépendant. Le dernier relevé a affiché ses 11 résultats mais Slither
a terminé avec le code de sortie 255.

## Structure du dépôt

```
contracts/   contrats Solidity (+ mocks de test)
test/        tests unitaires, intégration, sécurité, fuzzing
scripts/     déploiement et vérification des rôles
frontend/    dApp React
docs/        rapport, captures, rapport Slither
```
