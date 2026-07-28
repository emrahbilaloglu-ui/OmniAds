#!/usr/bin/env node
/**
 * Semantic validation of GitHub Actions workflows, BEFORE GitHub sees them.
 *
 * WHY THIS EXISTS. A range replacement in ci.yml deleted two sibling job blocks
 * — `build` and `detect-runtime-changes` — while three surviving jobs still
 * declared `needs: detect-runtime-changes`. GitHub rejected the whole workflow
 * at parse time: run 30353317867 completed as `failure` with `jobs: []`, zero
 * check runs and no logs. There was nothing to read and nothing to reproduce.
 *
 * The important property of that failure is that CI CANNOT CATCH IT. A workflow
 * that is semantically invalid never creates a job, so no step of ours ever
 * runs. The only place it can be caught is here, before the push. That is also
 * why YAML parsing is not enough: the file parsed perfectly. It was well-formed
 * and meaningless.
 *
 * ON actionlint. It is the right tool and this script defers to it when it is
 * already on PATH, so an operator who installs it gets its full analysis. What
 * this script will NOT do is fetch a binary during install or verification:
 * pulling an executable from the network as a side effect of running tests is a
 * supply-chain hazard out of proportion to the problem. The checks below are
 * self-contained, need no network, and cover the class that actually broke us
 * plus its close neighbours.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";

const DIR = ".github/workflows";
const problems = [];
const note = (file, message) => problems.push(`${file}: ${message}`);

/** GitHub's own job-id rule. */
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function collectNeeds(job) {
  if (!job || job.needs == null) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function checkWorkflow(file, source) {
  let doc;
  try {
    doc = yaml.load(source);
  } catch (error) {
    note(file, `does not parse as YAML: ${error.message}`);
    return;
  }
  if (!doc || typeof doc !== "object") {
    note(file, "is empty or not a mapping");
    return;
  }
  // `on:` is the YAML 1.1 boolean `true` once loaded, which is a genuine trap:
  // a workflow with no trigger is silently inert rather than rejected.
  if (!("on" in doc) && !(true in doc)) note(file, "declares no `on:` trigger");

  const jobs = doc.jobs;
  if (!jobs || typeof jobs !== "object") {
    note(file, "declares no jobs");
    return;
  }
  const ids = Object.keys(jobs);

  // Duplicate job ids: the loader keeps the last one, so the earlier job simply
  // vanishes with no error anywhere.
  const declared = [...source.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_-]*):$/gm)].map((m) => m[1]);
  const seen = new Set();
  for (const id of declared) {
    if (seen.has(id)) note(file, `declares job '${id}' more than once; the later one silently wins`);
    seen.add(id);
  }

  for (const id of ids) {
    if (!JOB_ID.test(id)) note(file, `job id '${id}' is not a valid GitHub job id`);
    const job = jobs[id] ?? {};

    // THE FAILURE THIS FILE EXISTS FOR.
    for (const need of collectNeeds(job)) {
      if (!ids.includes(need)) {
        note(
          file,
          `job '${id}' needs '${need}', which is not a job in this workflow — GitHub rejects the whole file and creates NO jobs`,
        );
      }
    }

    const reusable = typeof job.uses === "string";
    if (!reusable) {
      if (!job["runs-on"]) note(file, `job '${id}' has no runs-on`);
      if (!Array.isArray(job.steps) || job.steps.length === 0) {
        note(file, `job '${id}' has no steps`);
      }
    }

    for (const [index, step] of (job.steps ?? []).entries()) {
      const where = `job '${id}' step ${index + 1}${step?.name ? ` (${step.name})` : ""}`;
      if (!step || typeof step !== "object") {
        note(file, `${where} is not a mapping`);
        continue;
      }
      const hasRun = typeof step.run === "string";
      const hasUses = typeof step.uses === "string";
      if (hasRun === hasUses) {
        note(file, `${where} must have exactly one of run: or uses:`);
      }
      // An unpinned action resolves to whatever that ref points at today.
      if (hasUses && !step.uses.includes("@") && !step.uses.startsWith("./")) {
        note(file, `${where} uses '${step.uses}' without a version ref`);
      }
    }

    // `if: needs.X...` where X is not among this job's needs is always
    // undefined, so the condition quietly evaluates to false and the job never
    // runs — a silent no-op rather than an error.
    const declaredNeeds = new Set(collectNeeds(job));
    const ifText = typeof job.if === "string" ? job.if : "";
    for (const match of ifText.matchAll(/needs\.([A-Za-z0-9_-]+)/g)) {
      if (!declaredNeeds.has(match[1])) {
        note(
          file,
          `job '${id}' has an if: referencing needs.${match[1]} but does not declare it in needs; the expression is always undefined`,
        );
      }
    }
  }

  // Cycles: GitHub rejects these too, and they are easy to create by hand.
  const visiting = new Set();
  const done = new Set();
  const walk = (id, trail) => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      note(file, `needs cycle: ${[...trail, id].join(" -> ")}`);
      return;
    }
    visiting.add(id);
    for (const need of collectNeeds(jobs[id])) {
      if (ids.includes(need)) walk(need, [...trail, id]);
    }
    visiting.delete(id);
    done.add(id);
  };
  for (const id of ids) walk(id, []);

  return { ids, needs: [...new Set(ids.flatMap((id) => collectNeeds(jobs[id])))] };
}

if (!fs.existsSync(DIR)) {
  console.error(`[workflow-semantics] ${DIR} does not exist`);
  process.exit(1);
}

const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
if (files.length === 0) {
  console.error("[workflow-semantics] no workflow files found");
  process.exit(1);
}

console.log(`[workflow-semantics] validating ${files.length} workflow(s) in ${DIR}`);
for (const file of files) {
  const full = path.join(DIR, file);
  const summary = checkWorkflow(file, fs.readFileSync(full, "utf8"));
  if (summary) {
    const undef = summary.needs.filter((n) => !summary.ids.includes(n));
    console.log(
      `  ${file}\n    jobs  : ${summary.ids.join(", ")}\n` +
        `    needs : ${summary.needs.length ? summary.needs.sort().join(", ") : "(none)"}\n` +
        `    needs \\ jobs : ${undef.length ? undef.join(", ") : "(empty)"}`,
    );
  }
}

// Defer to actionlint when the operator already has it. Never fetched here.
try {
  execFileSync("actionlint", ["-version"], { stdio: "ignore" });
  console.log("[workflow-semantics] actionlint found on PATH; running it as well");
  execFileSync("actionlint", { stdio: "inherit" });
  console.log("[workflow-semantics] actionlint clean");
} catch (error) {
  if (error && error.code === "ENOENT") {
    console.log(
      "[workflow-semantics] actionlint not on PATH; ran built-in checks only " +
        "(install it for full analysis — deliberately not downloaded automatically)",
    );
  } else if (error && typeof error.status === "number" && error.status !== 0) {
    problems.push("actionlint reported problems (see output above)");
  }
}

if (problems.length > 0) {
  console.error("\n[workflow-semantics] FAIL:");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    "\nGitHub rejects a semantically invalid workflow BEFORE creating any job:\n" +
      "the run completes as `failure` with jobs: [], no check runs and no logs.\n" +
      "CI cannot catch this for you — that is the whole reason this check is local.",
  );
  process.exit(1);
}

console.log("[workflow-semantics] PASS — every needs reference resolves, no cycles, every step well-formed");
