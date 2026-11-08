# Rapport comparatif d'audit — avant et après corrections

**Projet :** TWIZA — financement participatif avec gouvernance CFD
**Date du relevé final :** 5 novembre 2026
**Outil :** Slither 0.11.6  
**Compilateur :** solc 0.8.34  
**Périmètre :** contrats Solidity du projet, en excluant `node_modules` et les mocks de test.

## 1. Objet et méthode

Ce document compare les relevés Slither disponibles avant les corrections et
le relevé exécuté sur les contrats après les dernières corrections. Il résume
les problèmes détectés, les changements apportés et les alertes qui restent à
examiner.

Commande exécutée sur les sources finales :

```bash
slither . --filter-paths "node_modules|contracts/mocks"
```

Le relevé final actualisé le 5 novembre 2026 indique **11 résultats sur 48
contrats et 102 détecteurs**. Slither a affiché son résultat d'analyse, mais
le processus a retourné un code de sortie non nul (255). Les relevés bruts
n'étant pas inclus dans le dépôt, les détails ci-dessous constituent le
résumé conservé de l'analyse finale. Les relevés historiques annonçaient
successivement 14, puis 12 résultats.

Les rapports bruts ne contiennent pas de classement de sévérité validé. Ce
document n'attribue donc pas de niveaux « critique/élevé/moyen/faible » aux
détecteurs : un résultat Slither est un signal à examiner, pas à lui seul la
preuve d'une vulnérabilité exploitable.

## 2. Résumé avant / après

| État | Résultats rapportés | Changements notables |
|---|---:|---|
| Premier relevé | 14 | Signale notamment `reentrancy-no-eth`, `uninitialized-local`, `calls-loop`, `timestamp`, `low-level-calls` et `missing-inheritance`. |
| Relevé intermédiaire | 12 | `reentrancy-no-eth` et `uninitialized-local` ne sont plus signalés ; `calls-loop` demeure. |
| Dernier relevé | 11 | Le quorum est mémorisé au snapshot lors de la création de la proposition ; `calls-loop` ne figure plus dans la sortie. Les trois familles restantes sont `timestamp`, `low-level-calls` et `missing-inheritance`. |

Les nombres sont les totaux annoncés par les sorties originales ; plusieurs
résultats d'un même détecteur `timestamp` concernent des gardes différentes.

## 3. Findings corrigés

### 3.1 `reentrancy-no-eth` — `Crowdfunding.contribute`

**Avant :** l'appel externe `token.mint` précédait la mise à jour du statut de
la campagne en `Successful` lorsque l'objectif était atteint. Slither
signalait un état écrit après un appel externe.

**Correction :** la mise à jour du statut et l'émission de l'événement de
finalisation ont été placées avant `token.mint`. L'interaction avec le jeton
vient après les effets métier, conformément au motif Checks-Effects-
Interactions.

**Vérification :** le finding a disparu du deuxième et du relevé final. Les
tests Hardhat de contribution et de sécurité ont été relancés ; la suite
complète finale compte 47 tests réussis, notamment un test de reentrance sur
`refund`.

### 3.2 `uninitialized-local` — `Governance._execute`

**Avant :** le booléen local `ok` était déclaré sans initialisation explicite.

**Correction :** `ok` est initialisé à `false` avant les tentatives d'appel à
Crowdfunding. Le résultat ne passe à `true` qu'après une exécution réussie.

**Vérification :** le finding a disparu du deuxième et du relevé final.

### 3.3 `calls-loop` — calcul du quorum dans le parcours du keeper

**Avant :** `checkUpkeep` parcourait les propositions et appelait
`proposalSucceeded`, lequel recalculait le quorum en interrogeant l'offre
passée du jeton pour chaque proposition. Le premier et le deuxième relevés
signalaient un appel externe dans ce parcours.

**Correction :** à la création d'une proposition, Governance lit l'offre au
bloc snapshot, calcule le quorum de 20 % et stocke son seuil dans
`proposalQuorumThresholds`. La fonction `quorum` renvoie ensuite cette valeur
enregistrée, ce qui supprime l'appel externe répété dans `checkUpkeep`.

**Vérification :** le finding `calls-loop` ne figure plus dans la sortie finale.
Un test confirme le quorum calculé et vérifie qu'une contribution postérieure
ne le modifie pas. Les tests de gouvernance ciblés et les 47 tests Hardhat
complets ont réussi après les modifications.

## 4. Findings encore signalés

### 4.1 `timestamp` — échéances et vérifications d'état dans Crowdfunding

Le détecteur couvre les fonctions `contribute`, `finalizeCampaign`, `refund`,
`approveWithdrawal`, `withdrawFunds` et `freezeCampaign`. Les comparaisons
`block.timestamp` servent aux échéances de contribution et de finalisation ;
les autres lignes concernées sont des gardes sur les statuts, le gel ou le
retrait, regroupées par le détecteur dans le même finding.

**Évaluation :** les échéances sont requises par la logique métier. Un
horodatage de bloc peut être légèrement influencé par le producteur du bloc ;
il ne faut donc pas utiliser ces échéances pour une décision nécessitant une
précision à la seconde. Aucune modification n'a été faite pour masquer ce
signal.

### 4.2 `low-level-calls` — transferts ETH

Slither signale l'envoi d'ETH par `.call` dans `Crowdfunding.refund` et
`Treasury.executeTransaction`.

**Évaluation :** `.call` permet de rembourser ou payer une adresse qui peut
être un contrat. Le code suit Checks-Effects-Interactions, protège les
fonctions concernées contre la reentrance et vérifie le booléen de succès.
Un transfert qui échoue provoque un revert, ce qui annule aussi les effets de
la transaction. Le finding est conservé et doit être lu avec le code et les
tests ; le détecteur ne prouve pas à lui seul un défaut.

### 4.3 `missing-inheritance` — interfaces inter-contrats

Slither suggère l'héritage des interfaces `ICFDToken`, `ITreasury` et
`ICrowdfundingGovernance` par les contrats concrets correspondants.

**Évaluation :** les interfaces décrivent les appels faits entre contrats ;
leur héritage par les implémentations améliorerait la vérification des
signatures à la compilation, mais leur absence ne prouve pas un contrôle
d'accès défaillant. Cette suggestion n'a pas été appliquée, car elle
nécessiterait de réorganiser les interfaces partagées et n'était pas liée à
une anomalie comportementale démontrée.

## 5. Vérifications associées

Après les changements finaux :

- tests Hardhat : **47 réussis** après ajout des règles d'exclusion du
  créateur ;
- tests Python du bonus d'analyse : **2 réussis** ;
- ESLint frontend : réussi ;
- build frontend TypeScript/Vite : réussi ;
- builds Sepolia frontend : réussis avec des adresses de test, sans
  transaction réseau ;
- déploiement Hardhat simulé : réussi.

Le build frontend émet un avertissement de taille de bundle (> 500 kB
minifiés). Il ne bloque pas la compilation et n'est pas un finding Slither.

## 6. Limites et suivi

- Cette analyse statique n'est pas un audit indépendant ni une garantie
  d'absence de vulnérabilité.
- La boucle `checkUpkeep` parcourt toujours la liste des propositions ; son
  coût augmente avec leur nombre même si le calcul de quorum ne fait plus
  d'appel externe par élément. Une version de production devrait borner ou
  paginer ce parcours.
- Aucun déploiement réel sur Sepolia ni test des contrats déployés n'est
  attesté par ce rapport.
- Les fichiers de sortie bruts Slither ne sont pas inclus dans le dépôt ; les
  résultats et limites conservés sont résumés dans ce rapport.
