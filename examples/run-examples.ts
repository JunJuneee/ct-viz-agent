/**
 * Runs a set of representative queries through the agent and writes the actual
 * JSON outputs to examples/outputs/. Used to produce the README's example runs
 * and as a lightweight end-to-end smoke test against the live API.
 *
 *   npm run examples
 */
import fs from "fs";
import path from "path";
import { runAgent } from "../src/pipeline";
import { RequestSchema, RequestInput } from "../src/schemas/request";

const EXAMPLES: { name: string; request: RequestInput }[] = [
  {
    name: "01_time_trend_pembrolizumab",
    request: {
      query: "How has the number of trials for Pembrolizumab changed per year since 2015?",
      drug_name: "Pembrolizumab",
      start_year: 2015,
    },
  },
  {
    name: "02_phase_distribution_melanoma",
    request: { query: "How are melanoma trials distributed across phases?", condition: "melanoma" },
  },
  {
    name: "03_compare_drugs",
    request: { query: "Compare phases for trials involving Pembrolizumab vs Nivolumab." },
  },
  {
    name: "04_geographic_diabetes",
    request: { query: "Which countries have the most recruiting trials for diabetes?", condition: "diabetes", status: ["RECRUITING"] },
  },
  {
    name: "05_sponsor_drug_network",
    request: { query: "Show a network of sponsors and drugs for melanoma trials.", condition: "melanoma" },
  },
  {
    name: "06_enrollment_histogram",
    request: { query: "What is the distribution of enrollment sizes for breast cancer trials?", condition: "breast cancer" },
  },
  {
    name: "07_ranking_top_countries",
    request: { query: "Which countries have the most melanoma trials? Top 10.", condition: "melanoma" },
  },
  {
    name: "08_out_of_scope",
    request: { query: "What is the price of pembrolizumab and is it better than chemo?" },
  },
  {
    name: "09_needs_clarification",
    request: { query: "Show me some trials." },
  },
];

async function main(): Promise<void> {
  const outDir = path.join(__dirname, "outputs");
  fs.mkdirSync(outDir, { recursive: true });

  for (const ex of EXAMPLES) {
    process.stdout.write(`Running ${ex.name} ... `);
    try {
      const input = RequestSchema.parse(ex.request);
      const result = await runAgent(input);
      const file = path.join(outDir, `${ex.name}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({ request: ex.request, response: result }, null, 2),
      );
      const viz = result.visualization;
      if (!viz) {
        console.log(`ok (no visualization — status: ${result.meta.status})`);
      } else {
        const size = viz.data?.length ?? viz.nodes?.length ?? 0;
        console.log(`ok (${viz.type}, ${size} items, ${result.meta.analyzedTrials} trials analyzed)`);
      }
    } catch (err) {
      console.log(`FAILED: ${String(err)}`);
    }
  }
  console.log(`\nWrote outputs to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
