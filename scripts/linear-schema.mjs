// Regenerates src/providers/linear/fixtures/linear-schema.graphql, the introspected Linear API
// schema that client.test.ts validates every GraphQL document against.
//
// Usage: LINEAR_API_KEY=<personal API key> node scripts/linear-schema.mjs
//
// The key only needs read access; the script sends the standard introspection query and prints
// the schema as SDL under a dated header so a reviewer can see when the contract was captured.

import { writeFileSync } from "node:fs";
import { buildClientSchema, getIntrospectionQuery, printSchema } from "graphql";

const FIXTURE = new URL("../src/providers/linear/fixtures/linear-schema.graphql", import.meta.url);
const ENDPOINT = "https://api.linear.app/graphql";

const apiKey = process.env.LINEAR_API_KEY;
if (apiKey === undefined || apiKey.trim() === "") {
  console.error("LINEAR_API_KEY is required: a Linear personal API key with read access.");
  process.exit(1);
}

const response = await fetch(ENDPOINT, {
  method: "POST",
  headers: { authorization: apiKey, "content-type": "application/json" },
  body: JSON.stringify({ query: getIntrospectionQuery() }),
});
if (!response.ok) {
  console.error(`Linear introspection failed: HTTP ${response.status}`);
  process.exit(1);
}
const result = await response.json();
if (result.errors !== undefined || result.data === undefined) {
  console.error("Linear introspection failed:", JSON.stringify(result.errors ?? result));
  process.exit(1);
}

const date = new Date().toISOString().slice(0, 10);
const header = [
  `# Linear GraphQL API schema, introspected ${date} with scripts/linear-schema.mjs.`,
  "# Test fixture only: client.test.ts validates every document in LINEAR_GRAPHQL_DOCUMENTS against it.",
  "",
  "",
].join("\n");
writeFileSync(FIXTURE, header + printSchema(buildClientSchema(result.data)) + "\n");
console.log(`Wrote ${FIXTURE.pathname} (introspected ${date}).`);
