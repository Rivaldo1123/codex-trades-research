import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEMO_EXECUTOR_VERSION = "strict-demo-executor-v2";
export const DEFAULT_DEPLOYMENT_DECISION =
  "research/deployment/active-demo-candidate.json";

const EXECUTOR_SOURCE_FILES = [
  "demo-bot.js",
  "demo-contract-validation.js",
  "demo-deployment-gate.js",
  "demo-identities.js",
  "demo-learning.js",
  "demo-risk.js",
  "demo-trade-state.js",
  "demo-ws-client.js",
  "deriv-demo.js",
  "research.js",
];

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function structurallyEqual(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function resolveInside(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "" ||
      path.isAbsolute(relativePath)) {
    throw new Error("Deployment evidence path must be repository-relative.");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split("/"));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Deployment evidence path escapes the repository.");
  }
  return resolved;
}

async function readHashedJson(projectRoot, reference, label) {
  if (!reference || !isSha256(reference.sha256)) {
    throw new Error(`${label} identity is malformed.`);
  }
  const bytes = await readFile(resolveInside(projectRoot, reference.path));
  if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
    throw new Error(`${label} failed its checksum.`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is malformed JSON.`);
  }
}

function verifyQualificationCalculation({ candidate, evidence, protocol, result, strategyHash }) {
  if (protocol?.schemaVersion !== 1 ||
      protocol.kind !== "demo-candidate-qualification-protocol" ||
      protocol.candidateId !== candidate.candidateId ||
      protocol.strategyHash !== strategyHash ||
      !structurallyEqual(protocol.product, candidate.product) ||
      !structurallyEqual(protocol.executionAssumptions,
        candidate.executionAssumptions)) {
    throw new Error("Frozen qualification protocol does not match the deployment candidate.");
  }
  const rules = protocol.acceptanceRules;
  if (!rules || !Number.isSafeInteger(rules.minimumTrades) || rules.minimumTrades < 1 ||
      !Number.isSafeInteger(rules.minimumCalendarDays) || rules.minimumCalendarDays < 1 ||
      !Number.isFinite(rules.minimumNetExpectancy) || rules.minimumNetExpectancy <= 0 ||
      !Number.isFinite(rules.minimumLowerConfidenceBound) ||
      rules.minimumLowerConfidenceBound <= 0 ||
      !Number.isFinite(rules.maximumDrawdown) || rules.maximumDrawdown < 0) {
    throw new Error("Frozen qualification acceptance rules are malformed.");
  }
  if (result?.schemaVersion !== 1 ||
      result.kind !== "demo-candidate-validation-result" ||
      result.candidateId !== candidate.candidateId ||
      result.strategyHash !== strategyHash ||
      result.protocolSha256 !== evidence.protocol.sha256 ||
      result.executorSourceSha256 !== candidate.executorSourceSha256 ||
      result.independentEvaluation !== true || result.previouslyViewedBeforeSelection !== false ||
      !structurallyEqual(result.executionAssumptions,
        candidate.executionAssumptions)) {
    throw new Error("Validation result does not match the exact independent candidate evaluation.");
  }
  const selectedAt = Date.parse(protocol.candidateSelectedAt);
  const windowStart = Date.parse(result.evaluationWindow?.start);
  const windowEnd = Date.parse(result.evaluationWindow?.end);
  const generatedAt = Date.parse(result.generatedAt);
  if (![selectedAt, windowStart, windowEnd, generatedAt].every(Number.isFinite) ||
      selectedAt >= windowStart || windowStart >= windowEnd || windowEnd > generatedAt) {
    throw new Error("Validation chronology does not establish a prospectively frozen evaluation.");
  }
  const metrics = result.metrics;
  const passes = metrics &&
    Number.isSafeInteger(metrics.trades) && metrics.trades >= rules.minimumTrades &&
    Number.isSafeInteger(metrics.calendarDays) &&
      metrics.calendarDays >= rules.minimumCalendarDays &&
    Number.isFinite(metrics.netExpectancy) &&
      metrics.netExpectancy >= rules.minimumNetExpectancy &&
    Number.isFinite(metrics.dependenceAdjustedLowerConfidenceBound) &&
      metrics.dependenceAdjustedLowerConfidenceBound >= rules.minimumLowerConfidenceBound &&
    Number.isFinite(metrics.maximumDrawdown) &&
      metrics.maximumDrawdown <= rules.maximumDrawdown &&
    metrics.operationalFailures === 0;
  if (!passes) {
    throw new Error("Candidate metrics do not pass the frozen qualification rules.");
  }
  if (evidence.protocol?.sha256 === evidence.result?.sha256) {
    throw new Error("Qualification protocol and result must be distinct artifacts.");
  }
}

export async function computeDemoExecutorSourceSha256() {
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  const hash = createHash("sha256");
  hash.update(`${DEMO_EXECUTOR_VERSION}\n`);
  for (const file of EXECUTOR_SOURCE_FILES) {
    hash.update(`${file}\n`);
    hash.update(await readFile(path.join(sourceDirectory, file)));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function assertSameProduct(candidate, config) {
  const product = candidate.product;
  if (!product || product.symbol !== config.symbol || product.currency !== config.currency ||
      product.duration !== config.strategy.contractDuration ||
      product.durationUnit !== config.strategy.contractDurationUnit ||
      product.stake !== config.risk.stakeDemoUsd ||
      !Array.isArray(product.contractTypes) || product.contractTypes.length === 0 ||
      product.contractTypes.some((item) => !["CALL", "PUT"].includes(item))) {
    throw new Error("Deployment candidate product terms do not match the configured executor.");
  }
}

export async function verifyDemoDeploymentEligibility({
  config,
  projectRoot,
  strategyHash,
  decisionRelativePath = DEFAULT_DEPLOYMENT_DECISION,
}) {
  const decisionPath = resolveInside(projectRoot, decisionRelativePath);
  let decision;
  try {
    decision = JSON.parse(await readFile(decisionPath, "utf8"));
  } catch (error) {
    throw new Error(`Demo deployment is blocked: deployment decision unavailable (${error.message}).`);
  }
  if (decision?.schemaVersion !== 1 || decision.kind !== "demo-deployment-decision") {
    throw new Error("Demo deployment is blocked: deployment decision is malformed.");
  }
  if (decision.state !== "QUALIFIED_FOR_CONTROLLED_DEMO_VALIDATION" ||
      decision.executionAuthorized !== true || !decision.candidate) {
    throw new Error("Demo deployment is blocked: no candidate is qualified for controlled demo validation.");
  }

  const candidate = decision.candidate;
  if (typeof candidate.candidateId !== "string" || candidate.candidateId.trim() === "" ||
      candidate.strategyHash !== strategyHash ||
      candidate.executorVersion !== DEMO_EXECUTOR_VERSION ||
      !isSha256(candidate.executorSourceSha256)) {
    throw new Error("Demo deployment candidate identity does not match the running strategy or executor.");
  }
  assertSameProduct(candidate, config);
  const actualSourceHash = await computeDemoExecutorSourceSha256();
  if (candidate.executorSourceSha256 !== actualSourceHash) {
    throw new Error("Demo deployment candidate was qualified against different executor source.");
  }
  if (!candidate.evidence || !isSha256(candidate.evidence.sha256)) {
    throw new Error("Demo deployment qualification evidence identity is malformed.");
  }
  const evidence = await readHashedJson(
    projectRoot,
    candidate.evidence,
    "Demo deployment qualification evidence",
  );
  if (evidence?.schemaVersion !== 1 || evidence.kind !== "qualified-demo-candidate-evidence" ||
      evidence.decision !== "QUALIFIED_FOR_CONTROLLED_DEMO_VALIDATION" ||
      evidence.candidateId !== candidate.candidateId ||
      evidence.strategyHash !== strategyHash ||
      evidence.executorVersion !== DEMO_EXECUTOR_VERSION ||
      evidence.executorSourceSha256 !== actualSourceHash ||
      !evidence.protocol || !evidence.result) {
    throw new Error("Demo deployment evidence does not establish the exact candidate qualification.");
  }
  if (!candidate.executionAssumptions ||
      !Number.isFinite(candidate.executionAssumptions.maxProposalAgeSeconds) ||
      candidate.executionAssumptions.maxProposalAgeSeconds <= 0 ||
      !Number.isFinite(candidate.executionAssumptions.minimumWinNetPerUnitRisk) ||
      candidate.executionAssumptions.requireCompleteCandles !== true) {
    throw new Error("Demo deployment execution assumptions are missing or malformed.");
  }
  const [protocol, result] = await Promise.all([
    readHashedJson(projectRoot, evidence.protocol, "Frozen qualification protocol"),
    readHashedJson(projectRoot, evidence.result, "Independent validation result"),
  ]);
  verifyQualificationCalculation({
    candidate,
    evidence,
    protocol,
    result,
    strategyHash,
  });
  return {
    allowedContractTypes: [...candidate.product.contractTypes],
    candidateId: candidate.candidateId,
    executionAssumptions: { ...candidate.executionAssumptions },
    executorSourceSha256: actualSourceHash,
    strategyHash,
  };
}
