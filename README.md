# Copilot Cost Viewer

Extension VS Code qui suit la consommation de **GitHub Copilot Chat** (tokens, crédits IA, coût) et la répartit **par projet, dossier et tâche** dans un fichier CSV prêt pour Excel.

GitHub facture Copilot par utilisateur, organisation ou entreprise, sans notion de projet. Cette extension lit l'historique local des conversations Copilot, rattache chaque requête à un projet et à une tâche, et écrit une ligne par requête dans un `copilot-costs.csv` placé dans le projet concerné.

![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.90-007ACC) ![Licence](https://img.shields.io/badge/licence-MIT-green)

## Fonctionnalités

- **Coût par requête** : crédits IA enregistrés par Copilot quand ils existent, sinon calculés à partir des tokens (entrée, lecture et écriture de cache, sortie) et des tarifs des modèles.
- **Tarifs lus en direct dans VS Code** (écran *Language Models*), y compris les tarifs « long context ». 1 crédit = 0,01 USD par défaut.
- **Maille au choix** : un fichier par workspace, ou un fichier par dossier projet, détecté d'après les fichiers lus et modifiés par la conversation.
- **Tags de tâche** : par commande, ou en écrivant `#task:nom-de-tache` dans un message.
- **Plusieurs conversations sur un même projet** alimentent le même fichier, sans doublon.
- **CSV pensé pour Excel en français** : séparateur `;`, virgule décimale, UTF-8 avec BOM, lignes triées par date et heure.
- **Recalcul complet** de l'historique après un changement de maille, de tarifs ou de format, avec sauvegarde `.csv.bak`.
- **Rapprochement avec la facture GitHub** : totaux du mois par modèle, par jour et par workspace, sur tous les workspaces de la machine.
- **Barre d'état** : coût du jour et du mois, crédits, requêtes et tokens du workspace.

## Installation

### Depuis un fichier `.vsix`

1. Télécharger le `.vsix` depuis les [Releases](https://github.com/Ba-pt0u/vscode-copilot-costviewer/releases), ou le construire (voir plus bas).
2. Dans VS Code : `Ctrl+Maj+P` → **Extensions: Install from VSIX…** → choisir le fichier.
3. Recharger la fenêtre. L'indicateur de coût apparaît dans la barre d'état ; un clic ouvre le menu.

### Depuis les sources

```bash
git clone https://github.com/Ba-pt0u/vscode-copilot-costviewer.git
cd vscode-copilot-costviewer
npm install
npm run compile
npm run package   # produit copilot-costs-<version>.vsix
```

Pour déboguer : ouvrir le dossier dans VS Code puis `F5` (Extension Development Host).

## Commandes

Toutes sont dans la palette (`Ctrl+Maj+P`, préfixe **Copilot Coûts**) et dans le menu de la barre d'état.

| Commande | Rôle |
|---|---|
| Taguer une conversation | Choisir une conversation (la plus récente en premier), lui donner une tâche et, en maille dossier, un projet. Les lignes déjà écrites sont réécrites. |
| Enregistrer les coûts maintenant | Écrit immédiatement les requêtes terminées (sinon toutes les 5 minutes et à la fermeture). |
| Ouvrir le fichier de coûts | Dans Excel, dans VS Code ou dans l'Explorateur. |
| Tout recalculer | Réécrit tout l'historique avec la maille et les tarifs actuels. |
| Afficher les tarifs des modèles | Liste les tarifs lus dans VS Code. |
| Rapprochement avec la facture GitHub | Totaux d'un mois par modèle, jour et workspace, à comparer avec *GitHub › Billing › Usage*. |
| Diagnostic | Dossier lu, conversations reconnues, tokens mesurés ou estimés. |

## Réglages principaux

| Réglage | Défaut | Description |
|---|---|---|
| `copilotCosts.granularity` | `workspace` | `workspace` : un fichier à la racine. `folder` : un fichier par dossier projet. |
| `copilotCosts.folderDepth` | `1` | Profondeur du dossier projet sous la racine (mode `folder`). |
| `copilotCosts.priceSource` | `vscode` | `vscode` : tarifs lus dans VS Code. `settings` : tarifs imposés par `modelPrices`. |
| `copilotCosts.modelPrices` | tarifs Copilot | Tarifs de secours en crédits par million de tokens (`input`, `output`, `cached`, `cacheWrite`, `longInput`…). |
| `copilotCosts.creditPrice` | `0.01` | Valeur d'un crédit IA dans la devise. |
| `copilotCosts.longContextThreshold` | `272000` | Seuil de tokens d'entrée au-delà duquel les tarifs « long context » s'appliquent. |
| `copilotCosts.costBasis` | `tokens` | `tokens` (crédits IA) ou `premiumRequests` (ancienne facturation). |
| `copilotCosts.fileName` | `copilot-costs.csv` | Nom du fichier de coûts. |
| `copilotCosts.flushIntervalMinutes` | `5` | Fréquence d'écriture. |
| `copilotCosts.csvDelimiter` / `decimalSeparator` | `;` / `,` | Format du CSV. |
| `copilotCosts.includeConversationTitle` | `true` | Écrire le début du premier message (à désactiver si le CSV est partagé). |

## Calcul du coût

1. Si Copilot a enregistré les crédits consommés par la requête, ils sont repris tels quels (colonne *Source crédits* = `journal Copilot`).
2. Sinon : `crédits = (entrée hors cache × input + cache lu × cached + cache écrit × cacheWrite + sortie × output) / 1 000 000` (*Source crédits* = `calculé`).
3. `coût = crédits × creditPrice`.

Le modèle *Auto* est valorisé au tarif de sa famille. Quand les tarifs changent dans VS Code, l'extension propose de recalculer l'historique.

## Le fichier CSV

Une ligne par requête, colonnes :

`Date ; Heure ; Mois ; Utilisateur ; Workspace ; Projet ; Chemin projet ; Tâche ; Conversation ; ID session ; ID requête ; Modèle ; Multiplicateur ; Tokens entrée ; Tokens cache ; Tokens écriture cache ; Tokens sortie ; Tokens total ; Source tokens ; Crédits ; Source crédits ; Requêtes premium ; Coût tokens ; Coût requêtes premium ; Coût ; Devise`

Dans Excel : **Données › À partir d'un fichier texte/CSV**, puis un tableau croisé dynamique *Mois × Projet × Tâche*. Pour consolider plusieurs projets : **Données › Obtenir des données › À partir d'un dossier**.

Fermez le fichier dans Excel avant un recalcul : Windows le verrouille pendant qu'il est ouvert (l'écriture périodique réessaie au passage suivant).

## Rapprochement avec la facture

L'extension ne voit que ce qui passe par Copilot Chat dans VS Code sur ce poste. Ne sont pas comptés : Copilot CLI, github.com (revue de code, agent cloud), les autres postes ou éditeurs, les conversations supprimées et certains appels internes non enregistrés (titres, résumés de contexte, sous-agents).

Pour une imputation financière exacte, répartissez chaque mois le montant facturé par GitHub au prorata des crédits de chaque projet.

## Limites

- VS Code n'offre pas d'API de consommation Copilot : l'extension lit les fichiers locaux `%APPDATA%\Code\User\workspaceStorage\<id>\chatSessions`, dont le format n'est pas documenté et peut changer avec une mise à jour.
- Quand Copilot n'enregistre ni crédits ni tokens, les tokens sont estimés (caractères ÷ 4) et donc sous-estimés.
- VS Code supprime au bout d'un certain temps les anciennes conversations : leurs lignes restent dans le CSV mais ne peuvent plus changer de dossier lors d'un recalcul.
- Testé sur VS Code pour Windows ; macOS et Linux devraient fonctionner mais n'ont pas été vérifiés.

## Confidentialité

Tout reste local : l'extension lit les fichiers de VS Code et écrit dans vos dossiers, sans aucun appel réseau. Le CSV contient le début du premier message de chaque conversation (désactivable) et votre nom d'utilisateur Windows ; pensez-y avant de le versionner ou de le partager.

## Licence

[MIT](LICENSE)
