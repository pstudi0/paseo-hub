/**
 * Every sentence the Hub writes into a Linear agent session. Linear renders these verbatim in the
 * session timeline and in issue comments, so they address the person who delegated the issue, in
 * their language and without technical vocabulary. This file and the tool tables in `mirror.ts`
 * hold every user-facing word, so the wording, or the language, changes in one place.
 */
export const LINEAR_COPY = {
  ack: "Je regarde…",
  queued: "En attente…",
  started: "Au travail…",
  followUpReceived: "Je regarde…",
  followUpDelivered: "Message transmis.",
  followUpQueued: "Message noté, je m'en occupe dès que possible.",
  followUpUndeliverable: "Je n'ai pas pu transmettre ce message ; je le reprendrai ensuite.",
  stillWorking: "Toujours en cours…",
  /** The placeholder reply posted in a human thread, later rewritten with the answer. */
  workingInThread: "Je regarde…",
  turnFailed: (error: string): string => `Ce passage a échoué : ${error}`,
  dropNoProject:
    "Aucun projet n'est configuré pour cette équipe. Un administrateur doit ajouter le déclencheur correspondant, ou vérifier qui a le droit de me solliciter.",
  dropConfiguration:
    "La connexion Linear doit être réautorisée dans Paseo Hub avant que je puisse travailler.",
  dispatchFailed:
    "Je n'ai pas pu démarrer. Déléguez à nouveau l'issue, ou répondez ici pour réessayer.",
  stopped: (name?: string): string =>
    `Arrêté${name === undefined ? "" : ` à la demande de ${name}`}. Le travail en cours est conservé : déléguez à nouveau ou répondez ici pour reprendre.`,
  unassigned: "Arrêté : l'issue ne m'est plus déléguée. Le travail en cours est conservé.",
  nothingRunning: "Je n'ai rien en cours sur cette issue.",
  permissionWaitingWithoutAuthority: (title: string): string =>
    `J'attends une autorisation dans Paseo (${title}). Approuvez-la là-bas, ou autorisez-moi à répondre depuis Linear.`,
  questionInPaseo: (title: string): string =>
    `J'ai une question à laquelle il faut répondre dans Paseo (${title}).`,
  permissionResolved: "Autorisation traitée.",
  permissionRefused: (error: string): string => `Paseo a refusé cette réponse : ${error}`,
  permissionUnconfirmed: "Réponse envoyée à Paseo, sans confirmation. À vérifier du côté de Paseo.",
  workspaceUnrecoverable: (reason: string): string =>
    `Je n'ai pas pu retrouver l'espace de travail de l'issue (${reason}) ; je repars d'une branche neuve.`,
  fallbackResponse: "Terminé, sans résumé écrit.",
  runCompleted: "Terminé.",
} as const;

const RETRY_HINT = " Déléguez à nouveau l'issue, ou répondez ici, pour relancer un passage.";

const DAEMON_REASONS = new Set([
  "daemon_unreachable",
  "daemon_not_registered",
  "daemon_disconnected",
  "daemon_disconnected_mid_execution",
  "daemon_timeout",
]);
const RUNTIME_REASONS = new Set([
  "timeout",
  "step_hard_timeout",
  "whole_run_timeout",
  "workflow_timed_out",
]);
const IDLE_REASONS = new Set(["idle_timeout", "step_idle_timeout"]);
const CREDENTIAL_REASONS = new Set([
  "execution_credentials_unavailable",
  "github_authority_unavailable",
  "github_authority_scope_invalid",
  "github_integration_unavailable",
]);

/** The `error` activity body for a failed execution; every text ends with the retry hint. */
export function linearErrorFor(reason: string): string {
  if (DAEMON_REASONS.has(reason)) {
    return `La machine de ce projet est injoignable.${RETRY_HINT}`;
  }
  if (RUNTIME_REASONS.has(reason)) return `Ce passage a dépassé sa durée maximale.${RETRY_HINT}`;
  if (IDLE_REASONS.has(reason)) {
    return `Ce passage s'est arrêté après une trop longue inactivité.${RETRY_HINT}`;
  }
  if (reason === "agent_interrupted") return `Je me suis arrêté en cours de route.${RETRY_HINT}`;
  if (CREDENTIAL_REASONS.has(reason)) {
    return `Mes accès n'ont pas pu être préparés.${RETRY_HINT}`;
  }
  return `Ce passage a échoué : ${reason}.${RETRY_HINT}`;
}

export function isLinearIdleReason(reason: string): boolean {
  return IDLE_REASONS.has(reason);
}
